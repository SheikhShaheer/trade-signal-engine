'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { SignalDetail } from '@/components/SignalDetail';
import { api, API_BASE_URL } from '@/lib/api';
import type { Memo } from '@/lib/types';

function IdeaDetailInner() {
  const params = useParams<{ id: string }>();
  const id = Number.parseInt(params.id, 10);
  const [memo, setMemo] = useState<Memo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!Number.isInteger(id) || id <= 0) {
      setError('Invalid idea id.');
      return;
    }
    try {
      setMemo(await api.memo(id));
      setError(null);
    } catch {
      setError(`Cannot load idea #${id}. Is the API at ${API_BASE_URL} running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link href="/review" className="back-link">
            ← Review
          </Link>
          <h1>Idea detail</h1>
        </div>
      </div>
      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}
      {memo && <SignalDetail memo={memo} onReviewed={() => void load()} />}
    </div>
  );
}

export default function IdeaDetailPage() {
  return (
    <Suspense fallback={<div className="page empty-inline">Loading…</div>}>
      <IdeaDetailInner />
    </Suspense>
  );
}
