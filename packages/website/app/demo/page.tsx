import Image from "next/image";
import { DownloadPopover } from "../download-popover";

export const metadata = {
  title: "Demo - Zenbu.js",
};

export default function DemoPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-6">
      <Image
        src="/logo.png"
        alt=""
        width={78}
        height={87}
        className="[image-rendering:pixelated] h-10 w-auto"
      />
      <p className="mt-6 text-[17px] text-zinc-500 text-center leading-relaxed">
        A hackable piece of software built with Zenbu.js
      </p>
      <div className="mt-6">
        <DownloadPopover />
      </div>
    </div>
  );
}
