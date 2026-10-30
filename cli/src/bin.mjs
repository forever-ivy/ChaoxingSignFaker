#!/usr/bin/env node
import { main } from "./main.mjs"
main().catch((e) => { console.error(e); process.exit(1) })
