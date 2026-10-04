import './globals.css';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata = { title: 'Autoapplier' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav><Link href="/">Queue</Link><Link href="/stats">Stats</Link></nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
