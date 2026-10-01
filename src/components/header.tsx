import { Link } from 'waku';

export const Header = () => {
  return (
    <header className="flex items-center gap-4 p-6 lg:fixed lg:left-0 lg:top-0">
      <h2 className="text-lg font-bold tracking-tight">
        <Link to="/">OmisePay SG</Link>
      </h2>
      <nav className="flex items-center gap-3">
        <Link
          to="/payment"
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          💳 Payment
        </Link>
      </nav>
    </header>
  );
};
