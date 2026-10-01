/** Discord's hard limit for one message's content. */
export const MESSAGE_LIMIT = 2000;
/** A line that opens or closes a code fence, with the fence it uses. */
export const fence = /^\s*(`{3,}|~{3,})/;

/** Tracks whether a run of lines is inside a code fence. `step` takes each line and says whether it was fenced. */
export function fences(): { readonly open: string | undefined; step(line: string): boolean } {
  let open: string | undefined; // the line that opened the current fence
  return {
    get open() { return open; },
    step(line) {
      const next = line.match(fence)?.[1];
      const inside = open !== undefined;
      if (!next) return inside;
      const opener = open?.match(fence)?.[1];
      // A closing fence uses the same character, is at least as long, and has no info string.
      if (!opener) open = line;
      else if (next[0] === opener[0] && next.length >= opener.length && !line.trim().slice(next.length).trim()) open = undefined;
      return true;
    },
  };
}

/**
 * Split text into messages of at most `limit` characters, preferring line breaks.
 * An open code fence is closed at the end of a chunk and reopened in the next.
 */
export function chunk(text: string, limit = MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  const marker = (line: string) => line.match(fence)?.[1];
  let open: string | undefined; // the line that opened the current fence
  let lines: string[] = [];
  let content = false; // the chunk holds more than a reopened fence
  const size = () => lines.reduce((total, line) => total + line.length + 1, 0);
  const close = () => {
    if (content) chunks.push([...lines, ...(open ? [marker(open)!] : [])].join('\n'));
    lines = open ? [open] : []; content = false;
  };
  for (const line of text.split('\n')) {
    const next = marker(line);
    // Room for the separator and a closing fence, whichever fence is open after this line.
    const reserve = Math.max(open ? marker(open)!.length : 0, next?.length ?? 0) + 1;
    let rest = line;
    while (size() + rest.length + reserve > limit) {
      if (content) { close(); continue; }
      const width = Math.max(1, limit - size() - reserve);
      lines.push(rest.slice(0, width)); content = true; rest = rest.slice(width);
      close();
    }
    lines.push(rest); content ||= Boolean(rest.trim());
    if (next) {
      const opener = open && marker(open)!;
      // A closing fence uses the same character, is at least as long, and has no info string.
      if (!opener) open = line;
      else if (next[0] === opener[0] && next.length >= opener.length && !line.trim().slice(next.length).trim()) open = undefined;
    }
  }
  close();
  return chunks;
}
