import React, { useEffect, useState } from 'react';
import ReportPage from './components/ReportPage';

const AUTH_URL = process.env.REACT_APP_AUTH_URL || 'http://localhost:8081';

export default function App() {
  const [authed, setAuthed] = useState<boolean>(false);

  const check = async () => {
    const r = await fetch(`${AUTH_URL}/auth/me`, { credentials: 'include' });
    setAuthed(r.ok);
  };

  useEffect(() => { check(); }, []);

  const login = () => {
    window.location.href = `${AUTH_URL}/auth/login`;
  };

  const logout = async () => {
    await fetch(`${AUTH_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    setAuthed(false);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex gap-2">
        {!authed ? (
          <button className="px-3 py-2 bg-blue-600 text-white rounded" onClick={login}>Login</button>
        ) : (
          <>
            <span className="px-3 py-2 bg-green-600 text-white rounded">Authenticated</span>
            <button className="px-3 py-2 bg-gray-700 text-white rounded" onClick={logout}>Logout</button>
          </>
        )}
        <button className="px-3 py-2 bg-slate-200 rounded" onClick={check}>Re-check</button>
      </div>

      <ReportPage authed={authed} />
    </div>
  );
}
