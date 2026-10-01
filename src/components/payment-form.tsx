'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

// ============================================================
// Configuration is loaded dynamically from /api/config
// Please set OMISE_PUBLIC_KEY and OMISE_SECRET_KEY in .env
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
        },
        callback: (statusCode: number, response: any) => void,
      ) => void;
    };
    OmiseCard: any;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 16);
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
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
    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-500">
      {icons[brand] || ''}
    </span>
  );
};

// ── Main Component ──────────────────────────────────────────

export const PaymentForm = () => {
  const [name, setName] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [amount, setAmount] = useState('10.00');
  const [status, setStatus] = useState<PaymentStatus>('idle');
  const [error, setError] = useState('');
  const [chargeResult, setChargeResult] = useState<ChargeResult | null>(null);
  const [omiseLoaded, setOmiseLoaded] = useState(false);
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [isLive, setIsLive] = useState(false);
  const scriptLoaded = useRef(false);

  // ── Load Configuration & Omise.js ──

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
          return; // Stop loading if not configured
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

  // ── On mount: check if returning from 3DS ──

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const chargeId = params.get('charge_id');
    const ref = params.get('ref');
    const sessionChargeId = sessionStorage.getItem('omise_last_charge_id');
    
    // Check all possible tracking mechanisms
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
        throw new Error(data.error || 'Failed to verify charge');
      }

      setChargeResult(data);

      if (data.status === 'successful' && data.paid) {
        setStatus('success');
        sessionStorage.removeItem('omise_last_charge_id');
      } else if (data.status === 'failed') {
        setError(
          data.failure_message ||
            `Payment failed (${data.failure_code || 'unknown'})`,
        );
        setStatus('failed');
        sessionStorage.removeItem('omise_last_charge_id');
      } else if (data.status === 'pending') {
        // Still pending — poll a few times because 3DS webhook/status update can take a second
        if (attempt <= 5) {
          setTimeout(() => verifyCharge(endpoint, attempt + 1), 2000);
        } else {
          setError('Payment is still being processed. Please check your bank statement or contact support.');
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

  const cardBrand = getCardBrand(cardNumber);

  // ── Validation (SGD: min S$1.00, max S$20,000.00) ──

  const validateForm = useCallback((): string | null => {
    if (!name.trim()) return 'Cardholder name is required';
    const digits = cardNumber.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return 'Invalid card number';
    const expiryParts = expiry.split('/');
    if (expiryParts.length !== 2) return 'Invalid expiry date (MM/YY)';
    const month = parseInt(expiryParts[0]!, 10);
    const year = parseInt(expiryParts[1]!, 10);
    if (month < 1 || month > 12) return 'Invalid expiry month';
    const currentYear = new Date().getFullYear() % 100;
    if (year < currentYear || year > 99) return 'Card is expired or invalid year';
    if (cvc.length < 3 || cvc.length > 4) return 'Invalid CVC';
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 1.0)
      return 'Minimum amount is S$1.00';
    if (amountNum > 20000.0) return 'Maximum amount is S$20,000.00';
    return null;
  }, [name, cardNumber, expiry, cvc, amount]);

  // ── Submit ──

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');

      if (!omiseLoaded) {
        setError('Payment library is still loading. Please wait...');
        return;
      }

      const validationError = validateForm();
      if (validationError) {
        setError(validationError);
        return;
      }

      setStatus('tokenizing');

      const digits = cardNumber.replace(/\D/g, '');
      const expiryParts = expiry.split('/');
      const expirationMonth = parseInt(expiryParts[0]!, 10);
      const expirationYear = 2000 + parseInt(expiryParts[1]!, 10);

      try {
        // Step 1: Tokenize card via Omise.js
        const token = await new Promise<string>((resolve, reject) => {
          window.Omise.createToken(
            'card',
            {
              name: name.trim(),
              number: digits,
              expiration_month: expirationMonth,
              expiration_year: expirationYear,
              security_code: cvc,
            },
            (statusCode: number, response: any) => {
              if (statusCode === 200) {
                resolve(response.id);
              } else {
                reject(
                  new Error(
                    response.message ||
                      response.location ||
                      'Card tokenization failed',
                  ),
                );
              }
            },
          );
        });

        // Step 2: Create charge on server with return_uri for 3DS
        setStatus('charging');
        const amountInCents = Math.round(parseFloat(amount) * 100);

        // Build unique reference for this transaction
        const clientRef = 'om_ref_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        
        // Build the return URL — after 3DS, Omise redirects here
        // We append the ref to look it up on return
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
            (chargeData as any).error || 'Charge creation failed',
          );
        }

        // Step 3: Handle the charge result
        if (chargeData.status === 'successful' && chargeData.paid) {
          // Charge completed immediately (frictionless 3DS or no 3DS required)
          setChargeResult(chargeData);
          setStatus('success');
        } else if (
          chargeData.status === 'pending' &&
          chargeData.authorize_uri
        ) {
          // 3DS authentication required — redirect user
          setStatus('awaiting_3ds');
          // Store the charge ID securely in sessionStorage to survive the redirect
          sessionStorage.setItem('omise_last_charge_id', chargeData.id);
          const redirectUri = chargeData.authorize_uri;
          // Small delay to show the 3DS status to the user
          setTimeout(() => {
            window.location.href = redirectUri;
          }, 800);
        } else if (chargeData.status === 'failed') {
          throw new Error(
            chargeData.failure_message ||
              `Payment declined (${chargeData.failure_code || 'unknown'})`,
          );
        } else {
          throw new Error(
            `Unexpected charge status: ${chargeData.status}`,
          );
        }
      } catch (err: any) {
        setError(err.message || 'An unexpected error occurred');
        setStatus('idle');
      }
    },
    [name, cardNumber, expiry, cvc, amount, omiseLoaded, validateForm],
  );

  const handleReset = () => {
    setName('');
    setCardNumber('');
    setExpiry('');
    setCvc('');
    setAmount('10.00');
    setStatus('idle');
    setError('');
    setChargeResult(null);
  };

  // ── Render: Verifying state (returning from 3DS) ──

  if (status === 'verifying') {
    return (
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
            <svg className="h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <h3 className="mb-2 text-xl font-bold text-slate-800">Verifying Payment</h3>
          <p className="text-sm text-slate-500">
            Checking your 3D Secure authentication result…
          </p>
        </div>
      </div>
    );
  }

  // ── Render: Awaiting 3DS redirect ──

  if (status === 'awaiting_3ds') {
    return (
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-blue-50 p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100">
            <svg className="h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <h3 className="mb-2 text-xl font-bold text-indigo-800">
            3D Secure Verification
          </h3>
          <p className="text-sm text-indigo-600">
            Redirecting to your bank for authentication…
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Please do not close this window.
          </p>
        </div>
      </div>
    );
  }

  // ── Render: Success ──

  if (status === 'success' && chargeResult) {
    return (
      <div className="mx-auto w-full max-w-md">
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
            Your transaction has been processed
          </p>
          <div className="mb-6 space-y-3 rounded-xl bg-white/60 p-4 text-left backdrop-blur-sm">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Charge ID</span>
              <span className="font-mono text-xs text-slate-700">
                {chargeResult.id}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Amount</span>
              <span className="font-semibold text-slate-700">
                S${(chargeResult.amount / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Status</span>
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                {chargeResult.status}
              </span>
            </div>
            {chargeResult.card && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Card</span>
                <span className="text-slate-700">
                  {chargeResult.card.brand} •••• {chargeResult.card.last_digits}
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

  // ── Render: Failed (after 3DS or other failure) ──

  if (status === 'failed') {
    return (
      <div className="mx-auto w-full max-w-md">
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
            <div className="mb-6 space-y-2 rounded-xl bg-white/60 p-4 text-left text-sm backdrop-blur-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Charge ID</span>
                <span className="font-mono text-xs text-slate-700">
                  {chargeResult.id}
                </span>
              </div>
              {chargeResult.failure_code && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Error Code</span>
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

  // ── Render: Form ──

  const isProcessing = status === 'tokenizing' || status === 'charging';

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/50">
        {isConfigured === false && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <p className="font-bold">⚠️ Configuration Required</p>
            <p className="mt-1">
              Please configure your Omise Live Keys in the <code className="rounded bg-amber-100 px-1 font-mono text-xs">.env</code> file or <code className="rounded bg-amber-100 px-1 font-mono text-xs">src/config/omise.ts</code> to enable payments.
            </p>
          </div>
        )}
        
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-200 relative">
            <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            {isLive && (
              <span className="absolute -right-1 -top-1 flex h-4 w-4">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex h-4 w-4 rounded-full border-2 border-white bg-emerald-500"></span>
              </span>
            )}
          </div>
          <h2 className="text-xl font-bold text-slate-800">
            Credit Card Payment
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Secured by Omise · Singapore · 3D Secure
          </p>
          {!omiseLoaded && isConfigured !== false && (
            <p className="mt-2 animate-pulse text-xs text-indigo-500">
              Initializing secure connection...
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Amount */}
          <div>
            <label
              htmlFor="amount"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Amount (SGD)
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
                onChange={(e) =>
                  setAmount(e.target.value.replace(/[^0-9.]/g, ''))
                }
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 py-3 pl-10 pr-4 text-sm text-slate-800 transition-all placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="0.00"
                disabled={isProcessing}
              />
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Min S$1.00 · Max S$20,000.00
            </p>
          </div>

          {/* Cardholder Name */}
          <div>
            <label
              htmlFor="name"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Cardholder Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-800 transition-all placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100"
              placeholder="As shown on card"
              autoComplete="cc-name"
              disabled={isProcessing}
            />
          </div>

          {/* Card Number */}
          <div>
            <label
              htmlFor="card"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Card Number
            </label>
            <div className="relative">
              <input
                id="card"
                type="text"
                inputMode="numeric"
                value={cardNumber}
                onChange={(e) =>
                  setCardNumber(formatCardNumber(e.target.value))
                }
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3 pr-24 text-sm tracking-wider text-slate-800 transition-all placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="•••• •••• •••• ••••"
                autoComplete="cc-number"
                maxLength={19}
                disabled={isProcessing}
              />
              <CardBrandIcon brand={cardBrand} />
            </div>
          </div>

          {/* Expiry & CVC */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="expiry"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Expiry
              </label>
              <input
                id="expiry"
                type="text"
                inputMode="numeric"
                value={expiry}
                onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-800 transition-all placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="MM/YY"
                autoComplete="cc-exp"
                maxLength={5}
                disabled={isProcessing}
              />
            </div>
            <div>
              <label
                htmlFor="cvc"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                CVC
              </label>
              <input
                id="cvc"
                type="text"
                inputMode="numeric"
                value={cvc}
                onChange={(e) =>
                  setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))
                }
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-800 transition-all placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="•••"
                autoComplete="cc-csc"
                maxLength={4}
                disabled={isProcessing}
              />
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700">
              <svg
                className="mt-0.5 h-4 w-4 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
              <span>{error}</span>
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
                  ? 'Securing card…'
                  : 'Processing payment…'}
              </span>
            ) : (
              `Pay S$${parseFloat(amount || '0').toFixed(2)}`
            )}
          </button>

          {/* Security Note */}
          <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                clipRule="evenodd"
              />
            </svg>
            <span>3D Secure · 256-bit SSL · PCI DSS compliant</span>
          </div>
        </form>
      </div>
    </div>
  );
};
