/**
 * Locate string values inside raw JSON text so they can be replaced in place — this keeps
 * indentation, key order, line endings and the trailing newline byte-for-byte intact.
 */

export interface Range {
  start: number;
  end: number;
}

class Scanner {
  i = 0;
  constructor(readonly s: string) {
    if (s.charCodeAt(0) === 0xfeff) this.i = 1;
  }
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  string(): string {
    const start = this.i;
    if (this.s[this.i] !== '"') throw new SyntaxError(`Expected string at ${this.i}`);
    this.i++;
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === '\\') this.i += 2;
      else if (ch === '"') {
        this.i++;
        return JSON.parse(this.s.slice(start, this.i)) as string;
      } else this.i++;
    }
    throw new SyntaxError('Unterminated string');
  }
}

/** Map of JSON path (joined with \u0000) → range of every string value in the document. */
export function indexStrings(text: string): Map<string, Range> {
  const sc = new Scanner(text);
  const out = new Map<string, Range>();
  const value = (path: string[]): void => {
    sc.ws();
    const ch = text[sc.i];
    if (ch === '"') {
      const start = sc.i;
      sc.string();
      out.set(path.join('\u0000'), { start, end: sc.i });
    } else if (ch === '{') {
      sc.i++;
      sc.ws();
      if (text[sc.i] === '}') {
        sc.i++;
        return;
      }
      for (;;) {
        sc.ws();
        const key = sc.string();
        sc.ws();
        if (text[sc.i] !== ':') throw new SyntaxError(`Expected ':' at ${sc.i}`);
        sc.i++;
        value([...path, key]);
        sc.ws();
        if (text[sc.i] === ',') {
          sc.i++;
          continue;
        }
        if (text[sc.i] === '}') {
          sc.i++;
          return;
        }
        throw new SyntaxError(`Expected ',' or '}' at ${sc.i}`);
      }
    } else if (ch === '[') {
      sc.i++;
      sc.ws();
      if (text[sc.i] === ']') {
        sc.i++;
        return;
      }
      for (let n = 0; ; n++) {
        value([...path, String(n)]);
        sc.ws();
        if (text[sc.i] === ',') {
          sc.i++;
          continue;
        }
        if (text[sc.i] === ']') {
          sc.i++;
          return;
        }
        throw new SyntaxError(`Expected ',' or ']' at ${sc.i}`);
      }
    } else {
      const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(sc.i, sc.i + 64));
      if (!m) throw new SyntaxError(`Unexpected token at ${sc.i}`);
      sc.i += m[0].length;
    }
  };
  value([]);
  return out;
}

export interface StringEdit {
  path: string[];
  value: string;
}

/** Replace string values at the given paths; throws if a path isn't a string value. */
export function applyStringEdits(text: string, edits: StringEdit[]): string {
  if (!edits.length) return text;
  const index = indexStrings(text);
  const located = edits.map((e) => {
    const r = index.get(e.path.join('\u0000'));
    if (!r) throw new Error(`No string value at ${e.path.join('.')}`);
    return { ...r, value: e.value };
  });
  located.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of located) out = out.slice(0, e.start) + JSON.stringify(e.value) + out.slice(e.end);
  return out;
}
