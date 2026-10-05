import { Onest } from "next/font/google";
import "./globals.css";

const onest = Onest({ subsets: ["latin"], variable: "--font", display: "swap" });

export const metadata = {
  title: "MacWake",
  description: "Wake your Mac at home from anywhere.",
  appleWebApp: { capable: true, title: "MacWake", statusBarStyle: "black-translucent" },
  icons: { apple: "/apple-touch-icon.png" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#12142b" },
    { media: "(prefers-color-scheme: light)", color: "#eceef6" },
  ],
};

export default function Layout({ children }) {
  return (
    <html lang="en" className={onest.variable}>
      <body>{children}</body>
    </html>
  );
}
