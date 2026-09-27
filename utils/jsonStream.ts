// Incremental JSON scanner. A finished Batch job returns every chunk's audio as
// base64 inside one JSON document, which can be hundreds of MB for a long
// episode. Parsing it with response.json() needs the whole body as one string
// and fails or runs out of memory in the browser. This scanner is fed text
// pieces as they download and emits each element of the first array stored
// under `targetKey` as its own JSON string, so only one element is in memory.

const STRING_SPECIAL = /["\\]/g;
const MAX_TRACKED_STRING = 256;

export class JsonArrayStreamer {
  private readonly stack: string[] = [];
  private inString = false;
  private escape = false;
  private str = '';
  private strTooLong = false;
  private stringIsKey = false;
  private stringValueKey: string | null = null;
  private expectKey = false;
  private pendingKey: string | null = null;
  private valueKey: string | null = null;
  private targetDepth = -1;
  private item: string[] | null = null;
  private itemStart = 0;
  private started = false;
  // Set once the first `targetKey` array has closed; the caller may stop reading.
  targetDone = false;

  // True when the text seen so far forms one complete JSON value.
  get complete(): boolean {
    return this.started && !this.stack.length && !this.inString;
  }

  constructor(
    private readonly targetKey: string,
    private readonly onItem: (json: string) => void,
    private readonly onString?: (key: string, value: string) => void,
  ) {}

  push(text: string) {
    const n = text.length;
    let i = 0;
    if (this.item) this.itemStart = 0;
    while (i < n) {
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
          this.keep(text, i, i + 1);
          i++;
          continue;
        }
        STRING_SPECIAL.lastIndex = i;
        const match = STRING_SPECIAL.exec(text);
        const j = match ? match.index : n;
        this.keep(text, i, j);
        if (!match) break;
        if (text[j] === '\\') {
          this.keep(text, j, j + 1);
          this.escape = true;
          i = j + 1;
          continue;
        }
        this.inString = false;
        this.closeString();
        i = j + 1;
        continue;
      }
      const c = text[i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
        i++;
      } else if (c === '"') {
        this.inString = true;
        this.str = '';
        this.strTooLong = false;
        this.stringIsKey = this.expectKey;
        this.stringValueKey = this.expectKey ? null : this.valueKey;
        if (!this.expectKey) this.valueKey = null;
        i++;
      } else if (c === ':') {
        this.valueKey = this.pendingKey;
        this.pendingKey = null;
        this.expectKey = false;
        i++;
      } else if (c === ',') {
        this.expectKey = this.stack[this.stack.length - 1] === '{';
        this.valueKey = null;
        i++;
      } else if (c === '{' || c === '[') {
        if (this.targetDepth >= 0 && this.stack.length === this.targetDepth && !this.item) {
          this.item = [];
          this.itemStart = i;
        }
        const startsTarget = c === '[' && this.valueKey === this.targetKey && this.targetDepth < 0 && !this.targetDone;
        this.started = true;
        this.stack.push(c);
        if (startsTarget) this.targetDepth = this.stack.length;
        this.valueKey = null;
        this.expectKey = c === '{';
        i++;
      } else if (c === '}' || c === ']') {
        this.stack.pop();
        i++;
        if (this.item && this.stack.length === this.targetDepth) {
          this.item.push(text.slice(this.itemStart, i));
          const json = this.item.join('');
          this.item = null;
          this.onItem(json);
        } else if (this.targetDepth >= 0 && this.stack.length === this.targetDepth - 1) {
          this.targetDepth = -1;
          this.targetDone = true;
        }
        this.expectKey = false;
        this.valueKey = null;
      } else {
        // Numbers, true, false and null carry nothing we need.
        this.valueKey = null;
        i++;
      }
    }
    if (this.item) this.item.push(text.slice(this.itemStart));
  }

  // Keys and small values are tracked; long strings (audio) are skipped.
  private keep(text: string, from: number, to: number) {
    if (this.strTooLong || to <= from) return;
    if (this.str.length + (to - from) > MAX_TRACKED_STRING) {
      this.strTooLong = true;
      this.str = '';
      return;
    }
    this.str += text.slice(from, to);
  }

  private closeString() {
    if (this.stringIsKey) {
      this.pendingKey = this.strTooLong ? null : this.str;
    } else if (this.stringValueKey && !this.strTooLong) {
      this.onString?.(this.stringValueKey, this.str);
    }
    this.str = '';
  }
}

// Splits streamed text into complete lines (for JSONL result files).
export class LineStreamer {
  private parts: string[] = [];

  constructor(private readonly onLine: (line: string) => void) {}

  push(text: string) {
    let start = 0;
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      this.parts.push(text.slice(start, nl));
      this.emit();
      start = nl + 1;
    }
    if (start < text.length) this.parts.push(text.slice(start));
  }

  finish() {
    this.emit();
  }

  private emit() {
    const line = this.parts.join('');
    this.parts = [];
    if (line.trim()) this.onLine(line);
  }
}
