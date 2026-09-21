import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Toaster from "@/components/Toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: "mock kabu — 모의 거래소",
  description: "가상 투자·체결 엔진 로컬 데모",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" data-theme="dark-minimal-glass">
      <body>
        {/* The glass theme is specified on Inter, which has no Hangul coverage —
            Pretendard carries the Korean text. React hoists these into <head>;
            both degrade to the system stack if the CDN is unreachable. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <Nav />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        <Toaster />
      </body>
    </html>
  );
}
