import { Link } from 'waku';

export default async function AboutPage() {
  return (
    <div className="max-w-xl space-y-6 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
      <title>About OmisePay SG</title>
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          About OmisePay SG
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          OmisePay SG is a secure multi-currency checkout portal built for Omise Singapore, separating Customer order information from Cardholder payment and AVS details.
        </p>
      </div>

      <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-700">
        <div className="font-semibold text-slate-900">Supported Payment Capabilities</div>
        <ul className="list-disc space-y-1 pl-5 text-xs sm:text-sm text-slate-600">
          <li>Currencies: SGD (Visa, Mastercard, JCB), CAD (Visa, Mastercard)</li>
          <li>Apple Pay on the Web with Singapore merchant validation</li>
          <li>Mandatory 3D Secure 2.0 authentication &amp; backend verification guard</li>
          <li>International AVS billing address normalization and verification</li>
        </ul>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          to="/payment"
          className="inline-flex items-center rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
        >
          Go to Payment Portal
        </Link>
        <Link
          to="/"
          className="inline-flex items-center rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'static',
  } as const;
};
