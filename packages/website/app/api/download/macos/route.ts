import { NextResponse } from "next/server";

const REPO = "zenbu-labs/zenbu-demo-release";
const FALLBACK = `https://github.com/${REPO}/releases/latest`;

type Asset = { name: string; browser_download_url: string };

export const revalidate = 300;

export async function GET() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        next: { revalidate: 300 },
      },
    );
    if (!res.ok) {
      return NextResponse.redirect(FALLBACK, 302);
    }
    const data = (await res.json()) as { assets?: Asset[] };
    const assets = data.assets ?? [];
    const dmg =
      assets.find((a) => /arm64.*\.dmg$/i.test(a.name)) ??
      assets.find((a) => /\.dmg$/i.test(a.name));
    if (!dmg) {
      return NextResponse.redirect(FALLBACK, 302);
    }
    return NextResponse.redirect(dmg.browser_download_url, 302);
  } catch {
    return NextResponse.redirect(FALLBACK, 302);
  }
}
