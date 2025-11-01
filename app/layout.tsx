import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Color Burst: Bubble Shooter',
  description: '20-level bubble shooter with power-ups',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
