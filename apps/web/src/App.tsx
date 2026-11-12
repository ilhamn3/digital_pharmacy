export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between border-b border-slate-800">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded bg-emerald-500 flex items-center justify-center font-bold text-lg text-white">
            Rx
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-wide">Lanka Health Pharmacy</h1>
            <p className="text-xs text-slate-400">Core POS — Phase 1</p>
          </div>
        </div>
        <div className="flex items-center space-x-4 text-sm text-slate-300">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-800">
            System Online
          </span>
          <span className="text-xs text-slate-400">Asia/Colombo (UTC+05:30)</span>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center my-8">
          <h2 className="text-2xl font-bold text-slate-800 mb-2">Phase 1: Foundation Ready</h2>
          <p className="text-slate-600 max-w-2xl mx-auto mb-6">
            Database schema initialized with 22 tables, strict money constraints (NUMERIC 12,2),
            FEFO indexing, gap-free daily bill numbering, and role-based data models.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left max-w-3xl mx-auto text-sm">
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
              <span className="font-semibold text-slate-800 block mb-1">🔐 Auth & Roles</span>
              <span className="text-slate-500 text-xs">Owner, Pharmacist, Cashier with data masking rules.</span>
            </div>
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
              <span className="font-semibold text-slate-800 block mb-1">📦 Batch-Wise Stock</span>
              <span className="text-slate-500 text-xs">Single truth source via sum(batch_quantities). No drift.</span>
            </div>
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
              <span className="font-semibold text-slate-800 block mb-1">🧾 Zero-Gap Billing</span>
              <span className="text-slate-500 text-xs">INV-YYYYMMDD-XXXX sequential numbering with row locking.</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

