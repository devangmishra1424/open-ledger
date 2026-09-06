// Scaffold placeholder — owned by the UI+Wiring person, expected to be replaced (BUILD.md §9).
import './globals.css';

export const metadata = {
  title: 'Open Ledger',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
