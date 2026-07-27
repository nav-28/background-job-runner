import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import type { Metadata } from 'next';
import { Roboto } from 'next/font/google';
import type { ReactNode } from 'react';
import TopBar from '@/components/TopBar';
import Providers from './providers';

const roboto = Roboto({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700'],
  display: 'swap',
  variable: '--font-roboto',
});

export const metadata: Metadata = {
  title: 'web-app-template',
  description: 'Next.js + MUI + TanStack Query + Zustand template',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={roboto.variable} suppressHydrationWarning>
      <body>
        {/* Sets the color scheme class before hydration to avoid a theme flash. */}
        <InitColorSchemeScript attribute="class" defaultMode="system" />
        <Providers>
          <TopBar />
          <Container maxWidth="lg" component="main">
            <Box sx={{ py: 4 }}>{children}</Box>
          </Container>
        </Providers>
      </body>
    </html>
  );
}
