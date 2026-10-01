import { Link } from 'waku';
import { PaymentForm } from '../components/payment-form';

export default async function PaymentPage() {
  return (
    <div className="w-full max-w-2xl px-4">
      <title>Omise SG Payment</title>
      <div className="mb-8">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-500 transition-colors hover:text-indigo-600">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Home
        </Link>
      </div>
      <PaymentForm />
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'dynamic',
  } as const;
};
