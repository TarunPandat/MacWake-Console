export default function manifest() {
  return {
    name: "MacWake",
    short_name: "MacWake",
    description: "Wake your Mac at home from anywhere.",
    start_url: "/",
    display: "standalone",
    background_color: "#12142b",
    theme_color: "#12142b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
