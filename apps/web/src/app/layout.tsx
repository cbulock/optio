import type { Metadata } from "next";
import { Sora, IBM_Plex_Mono } from "next/font/google";
import { LayoutShell } from "@/components/layout/layout-shell";
import "./globals.css";

export const dynamic = "force-dynamic";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-mono",
});

export const metadata: Metadata = {
  title: "Optio",
  description: "Workflow orchestration for AI coding agents",
  icons: {
    icon: "/favicon.svg",
  },
};

function resolvePublicApiUrl(configuredUrl: string): string {
  if (!configuredUrl) return "";

  try {
    const configured = new URL(configuredUrl);
    const configuredIsLoopback =
      configured.hostname === "localhost" || configured.hostname === "127.0.0.1";

    // Don't inject a loopback API URL into browser HTML. It only works on the
    // Optio host itself and breaks remote NodePort access. Let the client map
    // the current web host (:30310) to the API host (:30400) instead.
    if (configuredIsLoopback) {
      return "";
    }
  } catch {
    // Fall back to the configured value if parsing fails.
  }

  return configuredUrl;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Inject runtime config so client-side code can derive the API WebSocket URL.
  // PUBLIC_API_URL is the browser-reachable API URL (e.g. http://localhost:30400
  // for local dev with NodePort, or empty for production ingress where web and
  // API share the same host).
  const publicApiUrl = resolvePublicApiUrl(process.env.PUBLIC_API_URL ?? "");

  // Default to dark; ThemeProvider applies the correct class on mount
  return (
    <html
      lang="en"
      className={`dark ${sora.variable} ${ibmPlexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Runtime config for client-side JS (WebSocket URL derivation) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__OPTIO_CONFIG=${JSON.stringify({ publicApiUrl }).replace(/</g, "\\u003c")}`,
          }}
        />
        {/* Inline script to prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("optio_theme");if(t==="light"){document.documentElement.classList.remove("dark");document.documentElement.classList.add("light")}else if(t==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches){document.documentElement.classList.remove("dark");document.documentElement.classList.add("light")}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased">
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
