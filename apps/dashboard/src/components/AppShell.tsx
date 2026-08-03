'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const NAV = [
  { href: '/', label: 'Bot', match: (path: string) => path === '/' },
  { href: '/trades', label: 'Trades', match: (path: string) => path.startsWith('/trades') },
  { href: '/positions', label: 'Positions', match: (path: string) => path.startsWith('/positions') },
  { href: '/ideas', label: 'Ideas', match: (path: string) => path.startsWith('/ideas') },
  { href: '/watchlist', label: 'Watchlist', match: (path: string) => path.startsWith('/watchlist') },
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
            <strong>Trading Bot</strong>
            <span>Paper mode · auto-trades approved signals</span>
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
        <p className="side-note">Scans markets, scores setups, and trades approved ideas automatically.</p>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="live-pill">Paper bot</span>
          <span className="topbar-muted">Approved signals trade without manual approval</span>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
