import { Link } from 'waku';

export default async function HomePage() {
  return (
    <div className="max-w-lg">
      <title>OmisePay SG - Credit Card Payment</title>
      <h1 className="text-4xl font-bold tracking-tight">
        OmisePay SG
      </h1>
      <p className="mt-3 text-slate-600">
        A minimal viable credit card payment prototype powered by{' '}
        <a href="https://www.omise.co" target="_blank" rel="noreferrer" className="text-indigo-600 underline">
          Omise
        </a>
        {' '}for Singapore (SGD).
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
      <div className="mt-8 space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <div className="flex items-center gap-2 font-bold">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500"></span>
          </span>
          Production Mode (Live)
        </div>
        <p>
          Ready for live SGD credit card processing with 3D Secure 2.0 via Omise Singapore.
        </p>
      </div>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'static',
  } as const;
};

