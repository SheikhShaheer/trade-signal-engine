'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, API_BASE_URL } from '@/lib/api';
import type { AuditEntry } from '@/lib/types';

export default function HistoryPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.audit();
      setEntries(result.entries);
      setError(null);
    } catch {
      setError(`Cannot reach API at ${API_BASE_URL}.`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>History</h1>
          <p>Your past review actions. Acknowledgement never places an order.</p>
        </div>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {entries.length === 0 ? (
        <div className="empty-inline">No decisions logged yet.</div>
      ) : (
        <table className="tool-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Idea</th>
              <th>Score</th>
              <th>Action</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={`${entry.memoId}-${entry.createdAt}-${index}`}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>
                  <Link href={`/ideas/${entry.memoId}`}>#{entry.memoId}</Link>
                </td>
                <td>{entry.memoScore.toFixed(1)}</td>
                <td>{entry.action}</td>
                <td>{entry.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
