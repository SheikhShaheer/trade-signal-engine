'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const NAV = [
  { href: '/', label: 'Overview', match: (path: string) => path === '/' },
  { href: '/review', label: 'Review', match: (path: string) => path.startsWith('/review') },
  { href: '/ideas', label: 'Ideas', match: (path: string) => path.startsWith('/ideas') },
  { href: '/history', label: 'History', match: (path: string) => path.startsWith('/history') },
  { href: '/settings', label: 'Settings', match: (path: string) => path.startsWith('/settings') },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">TSE</span>
          <div>
            <strong>Signal Engine</strong>
            <span>Manual review only</span>
          </div>
        </div>
        <nav className="side-nav">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={item.match(pathname) ? 'nav-link active' : 'nav-link'}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <p className="side-note">No broker link. No auto-orders. You decide.</p>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="live-pill">Live scanner</span>
          <span className="topbar-muted">Ideas only · you place any trade yourself</span>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
