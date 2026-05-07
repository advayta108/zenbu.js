export async function defaultServices(): Promise<void> {
  await import("./server");
  await import("./reloader");
  await import("./renderer-host");
  await import("./http");
  await import("./db");
  await import("./base-window");
  await import("./rpc");
  await import("./view-registry");
  await import("./window");
  await import("./installer");
  await import("./registry");
  await import("./advice-config");
  await import("./local-file-protocol");
  await import("./runtime-control");
  await import("./debug");
  await import("./file-scanner");
}
