import Link from "next/link";
import { Nav } from "../nav";

export const metadata = {
  title: "Download Zenbu",
  description: "Download Zenbu for macOS, Windows, and Linux.",
};

const RELEASES_URL = "https://github.com/zenbu-labs/zenbu/releases";

type Option = {
  label: string;
  note?: string;
  href: string;
};

type Platform = {
  name: string;
  options: Option[];
  comingSoon?: boolean;
};

type ReleaseAsset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: ReleaseAsset[] };

async function getLatestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/zenbu-labs/zenbu/releases/latest",
      {
        next: { revalidate: 600 },
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as Release;
  } catch {
    return null;
  }
}

function findAsset(
  release: Release | null,
  match: (name: string) => boolean,
): string {
  const asset = release?.assets.find((a) => match(a.name));
  return asset?.browser_download_url ?? RELEASES_URL;
}

export default async function DownloadPage() {
  const release = await getLatestRelease();
  const version = release?.tag_name ?? null;

  const platforms: Platform[] = [
    {
      name: "macOS",
      options: [
        {
          label: "Apple Silicon",
          note: "M-series, late 2020 or newer",
          href: findAsset(release, (n) => /-arm64\.dmg$/.test(n)),
        },
        {
          label: "Intel",
          note: "Macs from before late 2020",
          href: findAsset(
            release,
            (n) => n.endsWith(".dmg") && !n.includes("arm64"),
          ),
        },
      ],
    },
    {
      name: "Windows",
      comingSoon: true,
      options: [
        { label: "x64", href: "#" },
        { label: "ARM64", href: "#" },
      ],
    },
    {
      name: "Linux",
      comingSoon: true,
      options: [
        { label: "AppImage", href: "#" },
        { label: "Deb", href: "#" },
        { label: "AppImage", note: "ARM64", href: "#" },
      ],
    },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-[#F4F4F4] text-[#111] font-sans">
      <Nav />

      <section className="px-6 pt-20 pb-12 max-w-3xl mx-auto w-full text-center">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          Download Zenbu
        </h1>
        <p className="mt-4 text-sm text-zinc-500">
          Pick a build for your platform.
          {version && (
            <>
              {" "}
              <a
                href={`${RELEASES_URL}/tag/${version}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-zinc-300 underline-offset-2 hover:text-[#111] transition-colors"
              >
                Latest: {version}
              </a>
            </>
          )}
        </p>
      </section>

      <section className="px-4 sm:px-6 pb-28 max-w-3xl mx-auto w-full">
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-200 overflow-hidden">
          {platforms.map((platform) => (
            <div
              key={platform.name}
              className="relative grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3 sm:gap-6 px-4 sm:px-6 py-5 sm:py-6"
            >
              <div className="text-sm font-semibold">{platform.name}</div>
              <div className="flex flex-col gap-2">
                {platform.options.map((opt, i) => (
                  <a
                    key={i}
                    href={opt.href}
                    className="group flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm text-[#111] hover:border-[#111] hover:bg-zinc-50 transition-colors"
                  >
                    <span className="flex items-baseline gap-2 min-w-0">
                      <span className="font-medium truncate">{opt.label}</span>
                      {opt.note && (
                        <span className="text-xs text-zinc-400 truncate">{opt.note}</span>
                      )}
                    </span>
                    <DownloadIcon />
                  </a>
                ))}
              </div>
              {platform.comingSoon && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70 backdrop-blur-[1px]">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Coming soon
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-zinc-200 px-6 py-6 mt-auto">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-zinc-400">
          <Link href="/">Zenbu</Link>
          <div className="flex items-center gap-4">
            <a href="https://github.com/zenbu-labs/zenbu" target="_blank" rel="noreferrer" className="hover:text-zinc-600 transition-colors">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      className="w-4 h-4 shrink-0 text-zinc-400 group-hover:text-[#111] transition-colors"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5v6M5.5 8L8 10.5 10.5 8" />
    </svg>
  );
}
