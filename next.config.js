// Dev only: let phones/iPads on the home Wi-Fi load the dev server (Next blocks non-localhost origins by default).
// Production builds (`next build && next start`, Vercel) ignore this.
export default {
  allowedDevOrigins: ["192.168.0.162", "*.local"],
};
