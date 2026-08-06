import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Meridian Wellness CRM (Demo)",
  description: "Interactive demo — leads, pipeline, guest & health records for Meridian Wellness.",
  icons: {
    icon: "/favicon.ico",
    apple: "/favicon.ico",
  },
};

// Mobile/tablet: use the device width, allow the user to zoom (a11y), and let
// content extend under the notch/home-indicator so we can pad with safe-area insets.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
