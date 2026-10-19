import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CHARS | College football ratings",
  description: "Auditable hypothetical FBS playoff rankings by season",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
