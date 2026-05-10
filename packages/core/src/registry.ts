export interface ZenbuRegister {}

export type ResolvedDbRoot = ZenbuRegister extends { db: infer T }
  ? T
  : {};

export type ResolvedServiceRouter = ZenbuRegister extends { rpc: infer T }
  ? T
  : {};

export type ResolvedEvents = ZenbuRegister extends { events: infer T } ? T : {};
