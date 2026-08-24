import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Wetopia",
  description: "Le wiki de la communauté, tenu par un agent.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
