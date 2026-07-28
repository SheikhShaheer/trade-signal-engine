'use client';

import { Suspense } from 'react';
import IdeasPage from './IdeasClient';

export default function Page() {
  return (
    <Suspense fallback={<div className="page empty-inline">Loading…</div>}>
      <IdeasPage />
    </Suspense>
  );
}
