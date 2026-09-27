import { isLocale, LOCALE_COOKIE, pickLocale, type Locale } from "@mock-kabu/shared";
import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import MaintenanceBanner from "@/components/MaintenanceBanner";
import MobileTabBar from "@/components/MobileTabBar";
import Nav from "@/components/Nav";
import Toaster from "@/components/Toaster";
import { I18nProvider } from "@/lib/i18n";
import "./globals.css";

// A CSP nonce belongs to one response; cached HTML would reuse stale nonces.
export const dynamic = "force-dynamic";

const TITLES: Record<Locale, { title: string; description: string }> = {
  ko: { title: "mock kabu — 모의 거래소", description: "가상 투자·체결 엔진 로컬 데모" },
  en: { title: "mock kabu — Mock Exchange", description: "A simulated trading exchange" },
  ja: { title: "mock kabu — 模擬取引所", description: "仮想投資・約定エンジンのデモ" },
};

/** 쿠키에 고른 언어가 있으면 그것, 없으면 브라우저 언어(Accept-Language) */
async function requestLocale(): Promise<Locale> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;
  return pickLocale((await headers()).get("accept-language"));
}

export async function generateMetadata(): Promise<Metadata> {
  return TITLES[await requestLocale()];
}

// 하단 탭·매수/매도 바가 홈 인디케이터 위로 올라가도록 safe-area 값을 받는다.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale} data-theme="light" suppressHydrationWarning>
      <body>
        {/* 첫 화면을 그리기 전에 저장된 테마를 적용한다 — 다크를 고른 사람에게 라이트가 번쩍이지 않게. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("mock-kabu2:theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
        {/* The glass theme is specified on Inter, which has no Hangul coverage —
            Pretendard carries the Korean text. React hoists these into <head>;
            both degrade to the system stack if the CDN is unreachable. */}
        {/* 폰트 CSS는 첫 화면 전에 받아야 한다 — CDN 연결(DNS·TLS)을 미리 열어 대기를 줄인다. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* jsDelivr는 CSS(일반 연결)와 폰트 파일(CORS 연결)을 모두 준다 — 브라우저가 연결을 따로 쓴다. */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <I18nProvider initialLocale={locale}>
        <MaintenanceBanner />
        <Nav />
        {/* 폰에서는 하단 탭(약 3.5rem)에 내용이 가리지 않게 아래 여백을 더 둔다. */}
        <main className="mx-auto w-full max-w-[1400px] px-4 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
          {children}
        </main>
        <MobileTabBar />
        <Toaster />
        </I18nProvider>
      </body>
    </html>
  );
}
