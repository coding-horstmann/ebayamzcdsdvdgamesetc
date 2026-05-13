import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediaScout DE",
  description:
    "Online-Arbitrage fuer Brettspiele, CDs, DVD/Blu-ray und Games zwischen eBay.de und Amazon.de.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                    MediaScout DE
                  </h1>
                  <p className="text-sm text-slate-500">
                    Brettspiele, CDs, DVD/Blu-ray und Games per GTIN abgleichen.
                  </p>
                </div>
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
          <footer className="border-t border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 text-xs text-slate-500 sm:px-6">
              <span>Daten: Keepa &amp; eBay Browse API. Preise ohne Gewaehr.</span>
              <a href="/admin" className="font-medium hover:text-slate-800">
                Einstellungen
              </a>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
