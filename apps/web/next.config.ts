import type { NextConfig } from "next";

const serverUrl = process.env.OMNI_SERVER_URL ?? "http://127.0.0.1:3000";

const nextConfig: NextConfig = {
  transpilePackages: ["@omni/api-client", "@omni/aep"],
  // Dev accessed via 127.0.0.1 / LAN IPs (e.g. phone on the same network):
  // without this, Next blocks its own HMR assets as cross-origin and the
  // client bundle never hydrates.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Dev shape: web on :3001 proxies /api to the control plane on :3000, so
  // cookies and WS share one origin from the browser's point of view. In a
  // single-origin deployment (web served by the control plane) the rewrites
  // simply pass through to themselves.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${serverUrl}/api/:path*` }];
  },
};

export default nextConfig;
