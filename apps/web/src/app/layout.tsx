import type { Metadata, Viewport } from "next";
import MobileTabBar from "@/components/MobileTabBar";
import Nav from "@/components/Nav";
import Toaster from "@/components/Toaster";
import "./globals.css";

// A CSP nonce belongs to one response; cached HTML would reuse stale nonces.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "mock kabu — 모의 거래소",
  description: "가상 투자·체결 엔진 로컬 데모",
};

// 하단 탭·매수/매도 바가 홈 인디케이터 위로 올라가도록 safe-area 값을 받는다.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" data-theme="dark" suppressHydrationWarning>
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
        {/* 폰에서는 하단 탭(약 3.5rem)에 내용이 가리지 않게 아래 여백을 더 둔다. */}
        <main className="mx-auto w-full max-w-[1400px] px-4 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
          {children}
        </main>
        <MobileTabBar />
        <Toaster />
      </body>
    </html>
  );
}
