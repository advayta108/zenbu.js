#!/usr/bin/env bun
import { runBuild } from "./build"

runBuild(process.argv.slice(2)).catch((err) => {
  console.error(err)
  process.exit(1)
})
