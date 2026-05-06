import { Service, runtime } from "#zenbu/init/src/main/runtime"

export class AppService extends Service {
  static key = "app"
  static deps = {}

  evaluate() {}
}

runtime.register(AppService, import.meta)
