import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Zenbu";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const [iconData, geistMono, geistMonoMedium] = await Promise.all([
    readFile(join(process.cwd(), "app/icon.png")),
    readFile(
      join(
        process.cwd(),
        "node_modules/geist/dist/fonts/geist-mono/GeistMono-Bold.ttf",
      ),
    ),
    readFile(
      join(
        process.cwd(),
        "node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.ttf",
      ),
    ),
  ]);

  const iconSrc = `data:image/png;base64,${iconData.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          background: "#F4F4F4",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Geist Mono",
          color: "#111",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 24,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={iconSrc} width={200} height={200} alt="" />
          <div
            style={{
              fontSize: 140,
              fontWeight: 700,
              letterSpacing: "-0.04em",
              lineHeight: 1,
              marginBottom: 8,
            }}
          >
            Zenbu
          </div>
        </div>
        <div
          style={{
            marginTop: 48,
            fontSize: 36,
            fontWeight: 500,
            color: "#71717a",
            letterSpacing: "-0.01em",
          }}
        >
          zenbu-labs/zenbu
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "Geist Mono",
          data: geistMono,
          style: "normal",
          weight: 700,
        },
        {
          name: "Geist Mono",
          data: geistMonoMedium,
          style: "normal",
          weight: 500,
        },
      ],
    },
  );
}
