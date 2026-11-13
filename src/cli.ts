#!/usr/bin/env node
import { main } from './main.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`depseek: ${e instanceof Error ? e.message : String(e)}\n`);
    if (process.env.DEPSEEK_DEBUG && e instanceof Error) process.stderr.write(`${e.stack}\n`);
    process.exitCode = 1;
  },
);
