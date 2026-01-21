import type { ReactNode } from 'react';

export const metadata = {
  title: 'AI SDK UI Streams',
  description: 'Agents SDK streaming UI with data and text stream examples.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '"Space Grotesk", "IBM Plex Sans", "Segoe UI", sans-serif',
          background:
            'radial-gradient(1200px 600px at 10% -10%, #1b2a4a 0%, rgba(11, 12, 16, 0) 60%), radial-gradient(900px 500px at 90% 0%, #1f3b2d 0%, rgba(11, 12, 16, 0) 55%), #0b0c10',
          color: '#f5f6f7',
        }}
      >
        {children}
      </body>
    </html>
  );
}
