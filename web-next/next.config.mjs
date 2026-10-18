/** @type {import('next').NextConfig} */

// Two ways to run the console.
//
// 1. Development, and the two-process local setup: Next serves the UI on its own port and the
//    browser talks to FastAPI on another. Both the socket and the plain requests go straight
//    to FastAPI — rewrites do not carry websocket upgrades, which is the usual trap, and the
//    proxy also hangs up partway through the ~400 KB whole-graph read while the trainer is
//    writing. CRASHGRAPH_API says where FastAPI is, and is baked into the bundle.
//
// 2. CRASHGRAPH_EXPORT=1: emit a plain static site into web-next/out, which the Python process
//    then serves itself. Everything here is client-side — the 3D views cannot render on a
//    server at all — so nothing is given up by exporting, and it collapses the deployment from
//    two hosts to one. Deliberately no origin is baked in: the browser calls whatever host
//    served the page, so there is no CORS, no mixed content, and no rebuild when the URL
//    changes. The runtime fallbacks in lib/console.ts and lib/store.ts handle that.
const EXPORT = process.env.CRASHGRAPH_EXPORT === "1";
const API = process.env.CRASHGRAPH_API ?? "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,

  // Separate build directories. Both modes write a full build, so sharing .next means an
  // export silently invalidates whatever `next start` is serving: the HTML keeps pointing at
  // chunk names that no longer exist and the page half-loads with 400s.
  ...(EXPORT
    ? { output: "export", distDir: ".next-export", images: { unoptimized: true } }
    : {
        env: {
          NEXT_PUBLIC_API_ORIGIN: API,
          NEXT_PUBLIC_WS_ORIGIN: API.replace(/^http/, "ws"),
        },
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${API}/api/:path*` }];
        },
      }),
};

export default nextConfig;
