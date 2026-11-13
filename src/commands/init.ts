import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_TEMPLATE } from '../config.js';
import type { Ctx } from '../context.js';

export function initCommand(ctx: Ctx): number {
  const file = join(ctx.cwd, 'depseek.config.json');
  if (existsSync(file) && !ctx.opts.force) {
    ctx.err(`${file} already exists (use --force to overwrite).`);
    return 1;
  }
  writeFileSync(file, CONFIG_TEMPLATE);
  ctx.out(ctx.painter.paint('ok', `✓ Created ${file}`));
  return 0;
}
