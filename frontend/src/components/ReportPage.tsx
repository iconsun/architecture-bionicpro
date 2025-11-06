import React, { useState } from 'react';

const AUTH_URL = process.env.REACT_APP_AUTH_URL || 'http://localhost:8081';

export default function ReportPage({ authed }: { authed: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const downloadReport = async () => {
    if (!authed) { setError('Not authenticated'); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${AUTH_URL}/api/reports`, {
        method: 'GET',
        credentials: 'include' // <— важно
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'report.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        className="px-3 py-2 bg-indigo-600 text-white rounded disabled:opacity-50"
        onClick={downloadReport}
        disabled={!authed || loading}
      >
        {loading ? 'Loading…' : 'Download report'}
      </button>
      {error && <div className="text-red-600">{error}</div>}
    </div>
  );
}
