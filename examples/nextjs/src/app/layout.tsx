import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent SDK Next.js Demo',
  description: 'A demo of the Agent SDK in Next.js',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`antialiased`}>{children}</body>
    </html>
  );
}
