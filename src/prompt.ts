import { createInterface } from 'node:readline/promises';

export async function confirm(question: string, def = false): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return a ? a === 'y' || a === 'yes' : def;
  } finally {
    rl.close();
  }
}
