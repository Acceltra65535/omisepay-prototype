import fs from 'node:fs';
import path from 'node:path';
import { Link } from 'waku';
import {
  isLiveEnvironment,
  isPublicKeyConfigured,
  isSecretKeyConfigured,
  OMISE_CONFIG,
} from '../config/omise';

function readEnvKey(name: string): string {
  const processVal = process.env[name];
  if (processVal && processVal.trim()) return processVal.trim();
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const regex = new RegExp(`^${name}=(.+)$`, 'm');
      const match = content.match(regex);
      if (match?.[1]) {
        return match[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Ignore file read errors
  }
  return '';
}

export default async function HomePage() {
  const publicKey = readEnvKey('OMISE_PUBLIC_KEY') || OMISE_CONFIG.publicKey;
  const secretKey = readEnvKey('OMISE_SECRET_KEY') || OMISE_CONFIG.secretKey;
  const isConfigured = isPublicKeyConfigured(publicKey) && isSecretKeyConfigured(secretKey);
  const isLive = isLiveEnvironment(publicKey, secretKey);

  return (
    <div className="max-w-lg">
      <title>OmisePay SG - Credit Card Payment</title>
      <h1 className="text-4xl font-bold tracking-tight">
        OmisePay SG
      </h1>
      <p className="mt-3 text-slate-600">
        A secure multi-currency payment portal powered by{' '}
        <a href="https://www.omise.co" target="_blank" rel="noreferrer" className="text-indigo-600 underline">
          Omise
        </a>
        {' '}supporting Singapore Dollar (SGD), US Dollar (USD), and Canadian Dollar (CAD).
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          to="/payment"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-all hover:from-indigo-700 hover:to-purple-700 hover:shadow-xl"
        >
          💳 Make a Payment
        </Link>
        <Link to="/about" className="inline-flex items-center rounded-xl border border-slate-200 px-6 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50">
          About
        </Link>
      </div>
      {!isConfigured ? (
        <div className="mt-8 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="font-bold">Omise Keys Not Configured · Multi-Currency</div>
          <p>
            Configure OMISE_PUBLIC_KEY and OMISE_SECRET_KEY in .env to enable SGD, USD, and CAD checkout.
          </p>
        </div>
      ) : isLive ? (
        <div className="mt-8 space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <div className="flex items-center gap-2 font-bold">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500"></span>
            </span>
            Production Mode (Live) · Multi-Currency
          </div>
          <p>
            Ready for live SGD, USD, and CAD card &amp; Apple Pay processing with 3D Secure 2.0 via Omise Singapore.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-800">
          <div className="font-bold">Test Mode (Sandbox) · Multi-Currency</div>
          <p>
            Connected with Omise test keys for SGD, USD, and CAD card &amp; Apple Pay testing with 3D Secure 2.0.
          </p>
        </div>
      )}
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'dynamic',
  } as const;
};
