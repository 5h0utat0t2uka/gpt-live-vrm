import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "../styles/globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
};
export async function generateMetadata(): Promise<Metadata> {
  const title = { template: `GPT‑Live VRM ・ %s`, default: "GPT‑Live VRM" };
  const url = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000";

  return {
    robots: {
      index: false,
      follow: false,
      noarchive: true,
      noimageindex: true,
    },
    metadataBase: new URL(url),
    alternates: { canonical: `/` },
    title: title,
    description: "Natural voice experiences with GPT‑Live‑1 with VRM avatars",
    openGraph: {
      title: title,
      description: "Natural voice experiences with GPT‑Live‑1 with VRM avatars",
      images: ["/ogp.png"],
    },
  };
}
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>
        <header>
          <div className="container">
            <h1>
              <Link href="/">GPT‑Live VRM</Link>
            </h1>
            <nav>
              <div className="container">
                <Link href="https://github.com/5h0utat0t2uka/gpt-live-vrm" target="_blank" rel="noopener noreferrer">
                  GitHub
                </Link>
                <Link href="/privacy">Privacy</Link>
              </div>
            </nav>
          </div>
        </header>
        {children}
        {/*<footer>
          <div className="container">
            <small>© 2026</small>
          </div>
        </footer>*/}
      </body>
    </html>
  );
}
