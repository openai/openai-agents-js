const MAX_COMMAND_BYTES = 8 * 1024 * 1024;

/** Bounded JSON capture before quoting/encoding fragments; invalid Unicode is rejected. */
export function boundedVoiceJSON(
  value: unknown,
  maxChars = MAX_COMMAND_BYTES,
): string {
  let chars = 0;
  let bytes = 0;
  let root = true;
  const counts = new WeakMap<object, number>();
  const add = (units: number, utf8 = units) => {
    chars += units;
    bytes += utf8;
    if (chars > maxChars || bytes > MAX_COMMAND_BYTES)
      throw new RangeError('Portable voice input exceeds capacity.');
  };
  const string = (text: string, encoded = false) => {
    const quotes = encoded ? 0 : 2;
    if (
      text.length > maxChars - chars - quotes ||
      text.length > MAX_COMMAND_BYTES - bytes - quotes
    )
      throw new RangeError('Portable voice input exceeds capacity.');
    add(quotes);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (!encoded && (code === 34 || code === 92)) add(2);
      else if (!encoded && code < 32)
        add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(++index);
        if (!(low >= 0xdc00 && low <= 0xdfff))
          throw new TypeError('Portable voice input contains invalid Unicode.');
        add(2, 4);
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw new TypeError('Portable voice input contains invalid Unicode.');
      else add(1, code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  };
  const json = JSON.stringify(
    value,
    function (this: unknown, key: string, raw: unknown) {
      let item = raw;
      // JSON unboxes these primitives after the replacer. Capture conversion once.
      if (item !== null && typeof item === 'object') {
        let boxed: unknown;
        try {
          boxed = String.prototype.valueOf.call(item);
        } catch {
          /* Other JSON values. */
        }
        if (typeof boxed === 'string') item = String(item);
        else {
          try {
            boxed = Number.prototype.valueOf.call(item);
          } catch {
            /* Other JSON values. */
          }
          if (typeof boxed === 'number') item = +(item as unknown as number);
          else {
            try {
              boxed = Boolean.prototype.valueOf.call(item);
            } catch {
              /* Other JSON values. */
            }
            if (typeof boxed === 'boolean') item = boxed;
          }
        }
      }
      const omitted =
        item === undefined ||
        typeof item === 'function' ||
        typeof item === 'symbol';
      if (root) {
        root = false;
        if (omitted) return undefined;
      } else {
        const array = Array.isArray(this);
        if (omitted && !array) return undefined;
        if (omitted) item = null;
        const parent = this as object;
        const count = counts.get(parent) ?? 0;
        if (count) add(1);
        counts.set(parent, count + 1);
        if (!array) {
          string(key);
          add(1);
        }
      }
      if (item === null) add(4);
      else if (typeof item === 'string') string(item);
      else if (typeof item === 'number') add(JSON.stringify(item).length);
      else if (typeof item === 'boolean') add(item ? 4 : 5);
      else if (typeof item === 'bigint')
        throw new TypeError('Portable voice input must be JSON.');
      else if (typeof item === 'object') {
        if (typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(item)) {
          // Raw JSON is emitted literally without another replacer traversal.
          string(item.rawJSON, true);
        } else {
          add(2);
          counts.set(item, 0);
        }
      }
      return item;
    },
  );
  if (json === undefined)
    throw new TypeError('Portable voice input must be JSON.');
  return json;
}
