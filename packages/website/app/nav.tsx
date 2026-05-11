import { NavClient } from "./nav-client";

async function getStars(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/zenbu-labs/zenbu",
      {
        next: { revalidate: 3600 },
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    const count = data.stargazers_count;
    if (typeof count !== "number") return null;
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return count.toString();
  } catch {
    return null;
  }
}

export async function Nav() {
  const stars = await getStars();
  return <NavClient stars={stars} />;
}
