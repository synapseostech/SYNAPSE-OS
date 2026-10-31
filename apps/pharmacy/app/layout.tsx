import type { Metadata } from "next"
import { synapseThemeFoucScript } from "@synapse/config/theme"
import { SynapseThemeProvider } from "@synapse/ui"
import "@synapse/config/typography.css"
import "./globals.css"
import { Toaster } from "@/components/ui/toaster"

/** Same type stack as synapseos.tech — IBM Plex Sans + Mono. */
export const metadata: Metadata = {
  title: "Synapse Pharm",
  description:
    "POS, FEFO batch inventory, and receipts built for Ugandan pharmacies — Synapse Health Technologies.",
}

/**
 * Production only: the worker caches the app shell and static assets so the
 * portal opens offline. API responses are never cached — they carry customer
 * PII and financial records — and writes stay online-only, because
 * offlineStorage.queueMutation deliberately throws.
 */
function serviceWorkerRegistrar(): string {
  if (process.env.NODE_ENV !== "production") return ""
  return `if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}`
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className="scroll-smooth"
      suppressHydrationWarning
    >
      <head>
        <link rel="icon" type="image/png" sizes="32x32" href="/logo.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/logo.png" />
        <link rel="shortcut icon" type="image/png" href="/logo.png" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#F97316" />
        <script
          dangerouslySetInnerHTML={{
            __html: serviceWorkerRegistrar(),
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: synapseThemeFoucScript({ syncDarkLightClass: true }),
          }}
        />
      </head>
      <body className="font-sans antialiased bg-background text-foreground">
        <SynapseThemeProvider>
          {children}
        </SynapseThemeProvider>
        <Toaster />
      </body>
    </html>
  )
}
