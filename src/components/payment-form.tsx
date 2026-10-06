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

// ============================================================
// Omise Singapore (SG) Production Payment Form
// Compliant with International Card AVS (Address Verification Service)
// and 3D Secure 2.0 (3DS)
// ============================================================

type PaymentStatus =
  | 'idle'
  | 'tokenizing'
  | 'charging'
  | 'awaiting_3ds'
  | 'verifying'
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
  failure_code: string | null;
  failure_message: string | null;
  card?: {
    last_digits: string;
    brand: string;
    name: string;
  };
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
  // Amex: 4-6-5 format
  if (/^3[47]/.test(digits)) {
    return digits
      .replace(/^(\d{4})(\d{0,6})(\d{0,5})/, (_, p1, p2, p3) =>
        [p1, p2, p3].filter(Boolean).join(' '),
      )
      .trim();
  }
  // Standard: 4-4-4-4 format
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

// ── Main Payment Form Component ─────────────────────────────

export const PaymentForm = () => {
  // Card Details
  const [name, setName] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [amount, setAmount] = useState('10.00');

  // AVS International Billing Address Fields
  const [country, setCountry] = useState('SG');
  const [street1, setStreet1] = useState('');
  const [street2, setStreet2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');

  // UI state & validation
  const [status, setStatus] = useState<PaymentStatus>('idle');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [chargeResult, setChargeResult] = useState<ChargeResult | null>(null);
  const [omiseLoaded, setOmiseLoaded] = useState(false);
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [isLive, setIsLive] = useState(false);
  const scriptLoaded = useRef(false);

  // Active country config
  const countryConfig: CountryConfig = useMemo(() => {
    return getCountryByCode(country);
  }, [country]);

  // Detected card brand
  const cardBrand = useMemo(() => getCardBrand(cardNumber), [cardNumber]);

  // Expected CVC length based on card brand (Amex = 4, others = 3)
  const maxCvcLength = cardBrand === 'amex' ? 4 : 3;

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

        if (!config.isConfigured) {
          return;
        }

        const setupOmise = () => {
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
    const sessionChargeId = sessionStorage.getItem('omise_last_charge_id');

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

  async function verifyCharge(endpoint: string, attempt = 1) {
    try {
      const response = await fetch(endpoint);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to verify charge status');
      }

      setChargeResult(data);

      if (data.status === 'successful' && data.paid) {
        setStatus('success');
        sessionStorage.removeItem('omise_last_charge_id');
      } else if (data.status === 'failed') {
        setError(
          data.failure_message ||
            `Payment declined (${data.failure_code || 'transaction_declined'})`,
        );
        setStatus('failed');
        sessionStorage.removeItem('omise_last_charge_id');
      } else if (data.status === 'pending') {
        if (attempt <= 5) {
          setTimeout(() => verifyCharge(endpoint, attempt + 1), 2000);
        } else {
          setError(
            'Payment is currently processing. Please check your bank statement or contact support.',
          );
          setStatus('failed');
        }
      } else {
        setError(`Unexpected charge status: ${data.status}`);
        setStatus('failed');
      }
    } catch (err: any) {
      if (attempt <= 3) {
        setTimeout(() => verifyCharge(endpoint, attempt + 1), 2000);
      } else {
        setError(err.message || 'Failed to verify payment');
        setStatus('failed');
      }
    }
  }

  // ── Country Switch Handler ─────────────────────────────────

  const handleCountryChange = (newCountryCode: string) => {
    setCountry(newCountryCode);
    setState('');
    setPostalCode('');
    // Clear country and postal error on switch
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.country;
      delete next.state;
      delete next.postalCode;
      return next;
    });
  };

  // ── Postal Code Input & Format Handler ──────────────────────

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

  // ── Comprehensive Form & AVS Validation ───────────────────

  const validateForm = useCallback((): {
    valid: boolean;
    mainError?: string | undefined;
    errors: Record<string, string>;
  } => {
    const errors: Record<string, string> = {};

    // 1. Amount validation (SGD 1.00 to SGD 20,000.00)
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 1.0) {
      errors.amount = 'Minimum amount is S$1.00';
    } else if (amountNum > 20000.0) {
      errors.amount = 'Maximum amount is S$20,000.00';
    }

    // 2. Cardholder Name
    if (!name.trim()) {
      errors.name = 'Cardholder name is required';
    } else if (name.trim().length < 2) {
      errors.name = 'Cardholder name is too short';
    }

    // 3. Card Number
    const rawCard = cardNumber.replace(/\D/g, '');
    if (!rawCard) {
      errors.cardNumber = 'Card number is required';
    } else if (rawCard.length < 13 || rawCard.length > 19) {
      errors.cardNumber = 'Invalid card number (13-19 digits required)';
    }

    // 4. Expiration Date
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

    // 5. CVC / CVV
    const rawCvc = cvc.replace(/\D/g, '');
    const requiredCvcLen = cardBrand === 'amex' ? 4 : 3;
    if (!rawCvc) {
      errors.cvc = 'CVC code is required';
    } else if (rawCvc.length < requiredCvcLen) {
      errors.cvc = `${cardBrand === 'amex' ? '4' : '3'}-digit CVC required`;
    }

    // 6. Strict International AVS Address Validation
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

    const errorKeys = Object.keys(errors);
    const valid = errorKeys.length === 0;
    const mainError = valid ? undefined : errors[errorKeys[0]!];

    return { valid, mainError, errors };
  }, [
    amount,
    name,
    cardNumber,
    expiry,
    cvc,
    cardBrand,
    country,
    street1,
    street2,
    city,
    state,
    postalCode,
    countryConfig,
  ]);

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

        const tokenCardData: Record<string, string | number> = {
          name: name.trim(),
          number: digits,
          expiration_month: expirationMonth,
          expiration_year: expirationYear,
          security_code: cvc.replace(/\D/g, ''),
          country: normalizedAddress.country,
          street1: normalizedAddress.street1,
          city: normalizedAddress.city,
        };

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

        // Step 2: Create charge on server with Singapore 3DS return_uri
        setStatus('charging');
        const amountInCents = Math.round(parseFloat(amount) * 100);

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
            currency: 'sgd',
            return_uri: returnUri,
            client_ref: clientRef,
          }),
        });

        const chargeData: ChargeResult = await chargeResponse.json();

        if (!chargeResponse.ok) {
          throw new Error(
            (chargeData as any).error || 'Payment processing failed',
          );
        }

        // Step 3: Handle result / 3D Secure redirection
        if (chargeData.status === 'successful' && chargeData.paid) {
          setChargeResult(chargeData);
          setStatus('success');
        } else if (
          chargeData.status === 'pending' &&
          chargeData.authorize_uri
        ) {
          setStatus('awaiting_3ds');
          sessionStorage.setItem('omise_last_charge_id', chargeData.id);
          const redirectUri = chargeData.authorize_uri;
          setTimeout(() => {
            window.location.href = redirectUri;
          }, 800);
        } else if (chargeData.status === 'failed') {
          throw new Error(
            chargeData.failure_message ||
              `Payment declined (${chargeData.failure_code || 'declined'})`,
          );
        } else {
          throw new Error(`Unexpected charge status: ${chargeData.status}`);
        }
      } catch (err: any) {
        setError(err.message || 'An unexpected error occurred during payment.');
        setStatus('idle');
      }
    },
    [
      name,
      cardNumber,
      expiry,
      cvc,
      amount,
      country,
      street1,
      street2,
      city,
      state,
      postalCode,
      countryConfig,
      omiseLoaded,
      validateForm,
    ],
  );

  const handleReset = () => {
    setName('');
    setCardNumber('');
    setExpiry('');
    setCvc('');
    setAmount('10.00');
    setCountry('SG');
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

  const isProcessing = status === 'tokenizing' || status === 'charging';

  // Base styling for form inputs
  const getInputClass = (fieldName: string) => {
    const hasError = Boolean(fieldErrors[fieldName]);
    return `w-full rounded-xl border ${
      hasError
        ? 'border-red-400 bg-red-50/20 text-red-900 focus:border-red-500 focus:ring-red-100'
        : 'border-slate-200 bg-slate-50/50 text-slate-800 focus:border-indigo-400 focus:bg-white focus:ring-indigo-100'
    } px-4 py-3 text-sm transition-all placeholder:text-slate-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60`;
  };

  // ── Render: Verifying (after 3DS callback) ─────────────────

  if (status === 'verifying') {
    return (
      <div className="mx-auto w-full max-w-lg">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
            <svg className="h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <h3 className="mb-2 text-xl font-bold text-slate-800">Verifying 3D Secure Payment</h3>
          <p className="text-sm text-slate-500">
            Communicating with card issuer for authorization…
          </p>
        </div>
      </div>
    );
  }

  // ── Render: Awaiting 3DS Redirect ──────────────────────────

  if (status === 'awaiting_3ds') {
    return (
      <div className="mx-auto w-full max-w-lg">
        <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-blue-50 p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100">
            <svg className="h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <h3 className="mb-2 text-xl font-bold text-indigo-800">
            3D Secure 2.0 Authentication
          </h3>
          <p className="text-sm text-indigo-600">
            Redirecting to your card issuer bank for security verification…
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Please do not refresh or close this browser window.
          </p>
        </div>
      </div>
    );
  }

  // ── Render: Success ────────────────────────────────────────

  if (status === 'success' && chargeResult) {
    return (
      <div className="mx-auto w-full max-w-lg">
        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
            <svg className="h-8 w-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 className="mb-2 text-2xl font-bold text-emerald-800">
            Payment Successful!
          </h3>
          <p className="mb-6 text-sm text-emerald-600">
            Your international card payment has been verified and processed
          </p>
          <div className="mb-6 space-y-3 rounded-xl bg-white/70 p-4 text-left backdrop-blur-sm">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Transaction ID</span>
              <span className="font-mono text-xs text-slate-700">
                {chargeResult.id}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Amount Charged</span>
              <span className="font-semibold text-slate-700">
                S${(chargeResult.amount / 100).toFixed(2)} SGD
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Status</span>
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                {chargeResult.status.toUpperCase()} (PAID)
              </span>
            </div>
            {chargeResult.card && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Card</span>
                <span className="text-slate-700 font-medium">
                  {chargeResult.card.brand.toUpperCase()} •••• {chargeResult.card.last_digits}
                </span>
              </div>
            )}
          </div>
          <button
            onClick={handleReset}
            className="w-full rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-emerald-700 hover:shadow-lg active:scale-[0.98]"
          >
            Make Another Payment
          </button>
        </div>
      </div>
    );
  }

  // ── Render: Failed ─────────────────────────────────────────

  if (status === 'failed') {
    return (
      <div className="mx-auto w-full max-w-lg">
        <div className="rounded-2xl border border-red-200 bg-gradient-to-br from-red-50 to-orange-50 p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h3 className="mb-2 text-2xl font-bold text-red-800">
            Payment Failed
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
                  <span className="text-slate-500">Decline Reason</span>
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
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // ── Render: Interactive Payment Form ───────────────────────

  return (
    <div className="mx-auto w-full max-w-lg">
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

        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-200 relative">
            <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            {isLive && (
              <span className="absolute -right-1 -top-1 flex h-4 w-4" title="Live Production Environment">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex h-4 w-4 rounded-full border-2 border-white bg-emerald-500"></span>
              </span>
            )}
          </div>
          <h2 className="text-xl font-bold text-slate-800">
            International Card Payment
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Omise SG · Global Visa / Mastercard / JCB / Amex · 3DS 2.0
          </p>
          {!omiseLoaded && isConfigured !== false && (
            <p className="mt-2 animate-pulse text-xs text-indigo-500 font-medium">
              Initializing Omise cryptographic gateway…
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Amount Field */}
          <div>
            <label htmlFor="amount" className="mb-1.5 block text-sm font-medium text-slate-700">
              Payment Amount (SGD)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
                S$
              </span>
              <input
                id="amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value.replace(/[^0-9.]/g, ''));
                  if (fieldErrors.amount) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.amount;
                      return next;
                    });
                  }
                }}
                className={getInputClass('amount') + ' pl-10'}
                placeholder="0.00"
                disabled={isProcessing}
              />
            </div>
            {fieldErrors.amount ? (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.amount}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                SGD 1.00 – SGD 20,000.00 · Settled in Singapore Dollars
              </p>
            )}
          </div>

          {/* ═══════════════════════════════════════════════ */}
          {/* Cardholder & Card Information                   */}
          {/* ═══════════════════════════════════════════════ */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-slate-100" />
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Card Information
              </span>
              <div className="h-px flex-1 bg-slate-100" />
            </div>

            {/* Cardholder Name */}
            <div>
              <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-slate-700">
                Cardholder Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (fieldErrors.name) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.name;
                      return next;
                    });
                  }
                }}
                className={getInputClass('name')}
                placeholder="Full name as printed on card"
                autoComplete="cc-name"
                maxLength={70}
                disabled={isProcessing}
              />
              {fieldErrors.name && (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.name}</p>
              )}
            </div>

            {/* Card Number */}
            <div>
              <label htmlFor="card" className="mb-1.5 block text-sm font-medium text-slate-700">
                Card Number
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
              {fieldErrors.cardNumber && (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.cardNumber}</p>
              )}
            </div>

            {/* Expiry & CVC */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="expiry" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Expiration
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
                  Security Code ({cardBrand === 'amex' ? '4 Digits' : 'CVC / CVV'})
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
          </div>

          {/* ═══════════════════════════════════════════════ */}
          {/* International Billing Address (AVS Standard)    */}
          {/* ═══════════════════════════════════════════════ */}
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-slate-100" />
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Billing Address (AVS)
              </span>
              <div className="h-px flex-1 bg-slate-100" />
            </div>

            {/* AVS Notification Banner */}
            {countryConfig.isAvsStrict ? (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-3 text-xs text-indigo-900">
                <div className="flex items-start gap-2">
                  <span className="text-sm">🛡️</span>
                  <div>
                    <span className="font-semibold">AVS Address Verification Required:</span>
                    <p className="mt-0.5 text-indigo-700">
                      Cards issued in {countryConfig.name} require your billing address to match your credit card statement exactly (including street number and postal code).
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5 text-xs text-slate-600">
                <span>
                  🌍 International Card Acceptance: Enter the billing address associated with this card.
                </span>
              </div>
            )}

            {/* Country Selection */}
            <div>
              <label htmlFor="country" className="mb-1.5 block text-sm font-medium text-slate-700">
                Country / Region of Card Issuance
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
                Street Address (Line 1)
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
                City / Town
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
                    {countryConfig.stateLabel}
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
                  <span>{countryConfig.postalLabel}</span>
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
                  ? 'Verifying AVS & Encrypting Card…'
                  : 'Processing Payment…'}
              </span>
            ) : (
              `Pay S$${parseFloat(amount || '0').toFixed(2)} SGD`
            )}
          </button>

          {/* Security & Compliance Badges */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-slate-400">
            <span className="inline-flex items-center gap-1">
              <svg className="h-3.5 w-3.5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              AVS Verification
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <svg className="h-3.5 w-3.5 text-indigo-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              3D Secure 2.0
            </span>
            <span>·</span>
            <span>PCI DSS Level 1</span>
          </div>
        </form>
      </div>
    </div>
  );
};
