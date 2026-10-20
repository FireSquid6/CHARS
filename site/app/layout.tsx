import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CHARS — College Football Archive", template: "%s | CHARS" },
  description: "Explore college football seasons, FBS standings, schedules and scores.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <header className="site-header"><div className="container header-inner"><Link className="brand" href="/" aria-label="CHARS home"><span className="brand-symbol">✦</span> CHARS<span className="brand-dot">.</span></Link><span className="header-caption">COLLEGE FOOTBALL, ARCHIVED.</span><Link className="header-link" href="/">All seasons <span aria-hidden="true">↗</span></Link></div></header>
        {children}
        <footer className="site-footer"><div className="container footer-inner"><span>CHARS <span className="brand-dot">✦</span> THE COLLEGE FOOTBALL ARCHIVE</span><span>Regular season data · FBS standings</span></div></footer>
      </body>
    </html>
  );
}
