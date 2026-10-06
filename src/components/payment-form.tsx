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
// Omise Singapore (SG) Production Payment & Invoicing Portal
// Enhanced for US High-Value Credit Card Transactions:
// - Explicit Customer Entity (`cust_...`)
// - Stripe Invoicing-style Invoice Reference & Line Item Description
// - Level 2 / Level 3 Transaction Metadata
// - Strict International AVS & 3D Secure 2.0 Compliance
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
  customer_id?: string | null;
  invoice_number?: string | null;
  invoice_description?: string | null;
  customer?: {
    email: string;
    name?: string | null;
    phone?: string | null;
    company?: string | null;
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

// ── Main Payment Form Component ─────────────────────────────

export const PaymentForm = () => {
  // Stripe Invoicing & Customer Entity Fields
  const [invoiceNumber, setInvoiceNumber] = useState(() => `INV-2026-${Math.floor(1000 + Math.random() * 9000)}`);
  const [invoiceDescription, setInvoiceDescription] = useState('Professional Consulting Services');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerCompany, setCustomerCompany] = useState('');

  // Payment Amount
  const [amount, setAmount] = useState('1500.00');

  // Card Details
  const [name, setName] = useState('');
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

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).ApplePaySession) {
      const isAvailable = (window as any).ApplePaySession.canMakePayments();
      setIsApplePayAvailable(isAvailable);
    }
  }, []);

  // Active country config
  const countryConfig: CountryConfig = useMemo(() => {
    return getCountryByCode(country);
  }, [country]);

  // Detected card brand
  const cardBrand = useMemo(() => getCardBrand(cardNumber), [cardNumber]);
  const maxCvcLength = cardBrand === 'amex' ? 4 : 3;

  // High-value calculation (>= S$1,000 SGD or US card)
  const isHighValue = useMemo(() => {
    const amt = parseFloat(amount || '0');
    return country === 'US' || amt >= 1000;
  }, [amount, country]);

  // Approximate USD amount reference (1 SGD ≈ 0.76 USD)
  const usdReference = useMemo(() => {
    const amt = parseFloat(amount || '0');
    if (isNaN(amt) || amt <= 0) return null;
    return (amt * 0.76).toFixed(2);
  }, [amount]);

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

  // ── Comprehensive Form, Invoicing & AVS Validation ────────

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

    // 2. Stripe Invoicing & Customer Entity Validation
    if (!customerEmail.trim()) {
      errors.customerEmail = 'Customer email is required for payment receipt & bank authorization';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())) {
      errors.customerEmail = 'Please enter a valid email address';
    }

    if (!invoiceNumber.trim()) {
      errors.invoiceNumber = 'Invoice reference number is required';
    }

    // 3. Cardholder Name
    if (!name.trim()) {
      errors.name = 'Cardholder name is required';
    } else if (name.trim().length < 2) {
      errors.name = 'Cardholder name is too short';
    }

    // 4. Card Number
    const rawCard = cardNumber.replace(/\D/g, '');
    if (!rawCard) {
      errors.cardNumber = 'Card number is required';
    } else if (rawCard.length < 13 || rawCard.length > 19) {
      errors.cardNumber = 'Invalid card number (13-19 digits required)';
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

    const errorKeys = Object.keys(errors);
    const valid = errorKeys.length === 0;
    const mainError = valid ? undefined : errors[errorKeys[0]!];

    return { valid, mainError, errors };
  }, [
    amount,
    customerEmail,
    country,
    isHighValue,
    invoiceNumber,
    name,
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
  ]);

  // ── Apple Pay Flow ─────────────────────────────────────────

  const handleApplePay = async () => {
    setError('');
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 1.0) {
      setError('Please enter a valid amount (Minimum S$1.00) before using Apple Pay.');
      return;
    }

    const request = {
      countryCode: 'SG',
      currencyCode: 'SGD',
      supportedNetworks: ['visa', 'masterCard', 'amex', 'discover'],
      merchantCapabilities: ['supports3DS'],
      total: { label: 'Omise Pay', amount: amt.toFixed(2) },
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
          setError('Apple Pay is not properly configured on this environment (Merchant Validation Failed).');
        }
      };

      session.onpaymentauthorized = async (event: any) => {
        try {
          setStatus('tokenizing');
          
          // Tokenize Apple Pay with Omise
          const token = await new Promise<string>((resolve, reject) => {
            window.Omise.createToken(
              'applepay',
              event.payment.token.paymentData,
              (statusCode: number, response: any) => {
                if (statusCode === 200) {
                  resolve(response.id);
                } else {
                  reject(new Error(response.message || 'Apple Pay tokenization failed'));
                }
              }
            );
          });

          setStatus('charging');
          const amountInCents = Math.round(amt * 100);
          const clientRef = 'om_ref_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
          const returnUri = window.location.origin + window.location.pathname + '?ref=' + clientRef;

          const chargeResponse = await fetch('/api/charge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token,
              amount: amountInCents,
              currency: 'sgd',
              return_uri: returnUri,
              client_ref: clientRef,
              is_apple_pay: true,
              customer: customerEmail ? { email: customerEmail } : undefined,
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

          if (chargeData.authorize_uri) {
            window.sessionStorage.setItem('omise_last_charge_id', chargeData.id);
            window.location.href = chargeData.authorize_uri;
            return;
          }

          session.completePayment({ status: (window as any).ApplePaySession.STATUS_SUCCESS });
          setChargeResult(chargeData);
          if (chargeData.status === 'successful') {
            setStatus('success');
          } else if (chargeData.status === 'failed') {
            setStatus('failed');
            setError(chargeData.failure_message || 'Payment failed');
          } else {
            setStatus('verifying');
            setTimeout(() => verifyCharge(`/api/charge/${chargeData.id}`), 2000);
          }
        } catch (err: any) {
          console.error('Apple Pay Error:', err);
          session.completePayment({ status: (window as any).ApplePaySession.STATUS_FAILURE });
          setError(err.message || 'Apple Pay transaction failed');
          setStatus('failed');
        }
      };

      session.begin();
    } catch (err: any) {
      console.error('Failed to start Apple Pay:', err);
      setError('Apple Pay is not available on this device or browser.');
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

        // Step 2: Create Customer Entity and Charge with Invoicing Context
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
            customer: {
              email: customerEmail.trim(),
              name: name.trim(),
              company: customerCompany.trim() || undefined,
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
      customerEmail,
      customerCompany,
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
      validateForm,
    ],
  );

  const handleReset = () => {
    setInvoiceNumber(`INV-2026-${Math.floor(1000 + Math.random() * 9000)}`);
    setName('');
    setCardNumber('');
    setExpiry('');
    setCvc('');
    setAmount('1500.00');
    setCustomerEmail('');
    setCustomerCompany('');
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
                {chargeResult.invoice_number || invoiceNumber} · {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
              </p>
            </div>
            <div className="rounded-lg border-2 border-emerald-600 bg-emerald-50 px-3 py-1 text-center font-bold uppercase tracking-wider text-emerald-700 text-sm">
              PAID ✓
            </div>
          </div>

          {/* Amount Summary */}
          <div className="mb-6 rounded-xl bg-slate-50 p-4 border border-slate-100">
            <span className="text-xs uppercase font-semibold text-slate-400">Total Amount Paid</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-slate-900">
                S${(chargeResult.amount / 100).toFixed(2)}
              </span>
              <span className="text-sm font-semibold text-slate-500">SGD</span>
            </div>
            {usdReference && (
              <p className="mt-1 text-xs text-slate-500">
                Approx. ~${usdReference} USD settled via Singapore Dollar
              </p>
            )}
          </div>

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
              <span className="text-slate-500">Customer Email</span>
              <span className="text-slate-800">
                {chargeResult.customer?.email || customerEmail}
              </span>
            </div>
            {(chargeResult.customer?.company || customerCompany) && (
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">Company / Organization</span>
                <span className="text-slate-800">
                  {chargeResult.customer?.company || customerCompany}
                </span>
              </div>
            )}
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Transaction ID</span>
              <span className="font-mono text-xs text-slate-700">
                {chargeResult.id}
              </span>
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
              <span className="rounded-md bg-indigo-100 px-2.5 py-1 text-xs font-bold text-indigo-700 font-mono">
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
              S${parseFloat(amount || '0').toFixed(2)} <span className="text-xs font-medium text-slate-500">SGD</span>
            </div>
            {usdReference && (
              <span className="text-xs font-medium text-indigo-600">
                ≈ ${usdReference} USD
              </span>
            )}
          </div>
        </div>

        {/* US High-Value Anti-Fraud Compliance Shield */}
        {isHighValue && (
          <div className="mb-6 rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50/90 via-blue-50/70 to-slate-50 p-4 text-xs text-indigo-950 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="text-xl">🏛️</span>
              <div className="space-y-1">
                <span className="font-bold text-indigo-900">
                  US High-Value Transaction Anti-Fraud Shield
                </span>
                <p className="text-slate-600 leading-relaxed">
                  In compliance with US card network (Visa / Mastercard / Amex) standards, a registered <strong>Customer Entity</strong> with verified AVS address and Level 2 Invoice metadata is attached. This maximizes authorization approval rates and prevents false-positive fraud declines from US issuing banks (Chase, Citi, BofA, Wells Fargo, Amex).
                </p>
              </div>
            </div>
          </div>
        )}

        {isApplePayAvailable && (
          <div className="mb-8">
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
            <div className="relative mt-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-3 text-slate-500 font-medium">Or pay with credit card</span>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Amount Field */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="amount" className="block text-sm font-medium text-slate-700">
                Payment Amount (SGD)
              </label>
              {usdReference && (
                <span className="text-xs font-medium text-slate-400">
                  Approx. ~${usdReference} USD
                </span>
              )}
            </div>
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
                className={getInputClass('amount') + ' pl-10 font-medium'}
                placeholder="0.00"
                disabled={isProcessing}
              />
            </div>
            {fieldErrors.amount ? (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.amount}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                Minimum S$1.00 · Maximum S$20,000.00 SGD
              </p>
            )}
          </div>

          {/* ═══════════════════════════════════════════════ */}
          {/* Section 1: Customer Identity & Invoicing        */}
          {/* (Creates explicit Customer entity in Omise)    */}
          {/* ═══════════════════════════════════════════════ */}
          <div className="space-y-4 pt-1">
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-slate-100" />
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Customer & Invoice Identity
              </span>
              <div className="h-px flex-1 bg-slate-100" />
            </div>

            {/* Customer Email & Phone Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  className={getInputClass('customerEmail')}
                  placeholder="billing@company.com"
                  autoComplete="email"
                  disabled={isProcessing}
                />
                {fieldErrors.customerEmail ? (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.customerEmail}</p>
                ) : (
                  <p className="mt-1 text-xs text-slate-400">For invoice receipt & bank 3DS</p>
                )}
              </div>
            </div>

            {/* Company / Organization (Optional) & Invoice Memo */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="customer_company" className="mb-1.5 flex items-center justify-between text-sm font-medium text-slate-700">
                  <span>Company / Organization</span>
                  <span className="text-xs font-normal text-slate-400">Optional</span>
                </label>
                <input
                  id="customer_company"
                  type="text"
                  value={customerCompany}
                  onChange={(e) => setCustomerCompany(e.target.value)}
                  className={getInputClass('customerCompany')}
                  placeholder="e.g. Acme Corporation LLC"
                  disabled={isProcessing}
                />
              </div>

              <div>
                <label htmlFor="invoice_desc" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Invoice Memo / Descriptor
                </label>
                <input
                  id="invoice_desc"
                  type="text"
                  value={invoiceDescription}
                  onChange={(e) => setInvoiceDescription(e.target.value)}
                  className={getInputClass('invoiceDescription')}
                  placeholder="Service description"
                  maxLength={60}
                  disabled={isProcessing}
                />
              </div>
            </div>
          </div>

          {/* ═══════════════════════════════════════════════ */}
          {/* Section 2: Credit Card Information              */}
          {/* ═══════════════════════════════════════════════ */}
          <div className="space-y-4 pt-1">
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
                Cardholder Name <span className="text-red-500">*</span>
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
              {fieldErrors.cardNumber && (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.cardNumber}</p>
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
          </div>

          {/* ═══════════════════════════════════════════════ */}
          {/* Section 3: Billing Address (AVS Standard)       */}
          {/* ═══════════════════════════════════════════════ */}
          <div className="space-y-4 pt-1">
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
              `Authorize Payment of S$${parseFloat(amount || '0').toFixed(2)} SGD`
            )}
          </button>

          {/* Compliance & Security Badges */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 font-medium text-slate-600">
              <svg className="h-3.5 w-3.5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Registered Customer Entity
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
