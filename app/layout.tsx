import type { Metadata } from "next";
import "./globals.css";

function metadataBase() {
  const configured = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!configured) return new URL("http://localhost:3000");
  return new URL(configured.startsWith("http") ? configured : `https://${configured}`);
}

export const metadata: Metadata = {
  title: "StartupSignal | Evidence-backed investment intelligence",
  description: "Turn a startup URL into an evidence-backed venture investigation, committee verdict, and living investment memo.",
  metadataBase: metadataBase(),
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
