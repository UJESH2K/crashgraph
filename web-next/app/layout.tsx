import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "crashgraph flight console",
  description:
    "A rocket lander with no neural network. Everything it knows is a FalkorDB graph of its own crashes.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

/* Pick the theme before first paint. Without this the page renders in the default and then
   swaps, which on a black console is a full-screen white flash. */
const THEME_BOOT = `(function(){try{
  var t = localStorage.getItem("crashgraph-theme");
  if (t !== "light" && t !== "dark") t = "dark";
  document.documentElement.dataset.theme = t;
}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href={
            "https://fonts.googleapis.com/css2" +
            "?family=Space+Grotesk:wght@500;600;700" +
            "&family=Inter:wght@400;500;600" +
            "&family=IBM+Plex+Mono:wght@400;500;600" +
            "&display=swap"
          }
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
