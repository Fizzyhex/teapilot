/** Readable text from a fetched page: markdown-like, with absolute links kept so the model can open them next. */
export interface Extracted { title: string; text: string; links: string[] }

export const htmlTypes = ['text/html', 'application/xhtml+xml'];
export const textTypes = ['text/plain', 'text/markdown', 'text/x-markdown'];

/** Decodes a body using the header charset, then a `<meta>` charset, then UTF-8. */
export function decode(body: Buffer, charset?: string, html = false): string {
  const declared = charset ?? (html ? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] : undefined);
  try { return new TextDecoder(declared || 'utf-8').decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
}

const named: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', divide: '÷', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', para: '¶', sect: '§',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', minus: '−', le: '≤', ge: '≥', ne: '≠', frac12: '½', frac14: '¼', frac34: '¾', euro: '€', pound: '£', yen: '¥', cent: '¢',
};
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

// Page furniture and anything that is not prose. Removed with its contents before the text is read.
const dropped = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'head', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'dialog'];
const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'blockquote', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'ul', 'ol', 'table', 'tr', 'details', 'summary', 'hr', 'address']);
const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>|[^<]+|</g;
const attribute = (attributes: string, name: string) => decodeEntities(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes)?.slice(1).find(value => value !== undefined) ?? '');
const plain = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function extractHtml(html: string, base: string): Extracted {
  const title = plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || attribute(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i.exec(html)?.[0] ?? '', 'content');
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of dropped) body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
  // Prefer the page's main content when it carries most of the text, so menus and teasers stay out.
  const total = plain(body).length;
  const main = [/<main\b[^>]*>([\s\S]*)<\/main\s*>/i, /<article\b[^>]*>([\s\S]*)<\/article\s*>/i]
    .map(pattern => pattern.exec(body)?.[1]).find(part => part !== undefined && plain(part).length >= total * 0.4);
  return { title, ...render(main ?? body, base) };
}

function render(html: string, base: string): { text: string; links: string[] } {
  let out = '';
  const links = new Set<string>();
  const anchors: Array<{ start: number; href?: string }> = [];
  let pre = 0, cell = 0;
  const block = (prefix = '') => { out = out.replace(/[ \t]+$/, ''); if (out && !out.endsWith('\n\n')) out += out.endsWith('\n') ? '\n' : '\n\n'; out += prefix; };
  for (const match of html.matchAll(tagPattern)) {
    const [token, rawName, attributes = ''] = match;
    if (token.startsWith('<!--')) continue;
    if (!rawName) {
      const text = decodeEntities(token === '<' ? '<' : token);
      if (pre) out += text;
      else {
        const squashed = text.replace(/\s+/g, ' ');
        out += /[\s(\[]$|^$/.test(out) || out.endsWith('- ') ? squashed.replace(/^ /, '') : squashed;
      }
      continue;
    }
    const name = rawName.toLowerCase(), closing = token.startsWith('</');
    if (/^h[1-6]$/.test(name)) { closing ? block() : block(`${'#'.repeat(Number(name[1]))} `); continue; }
    if (name === 'pre') { if (closing) { pre = Math.max(0, pre - 1); out += '\n```'; block(); } else { block('```\n'); pre++; } continue; }
    if (name === 'br') { out += '\n'; continue; }
    if (name === 'li') { if (!closing) { out = out.replace(/[ \t]+$/, ''); out += out && !out.endsWith('\n') ? '\n- ' : '- '; } continue; }
    if (name === 'tr') { cell = 0; if (!closing) out += out && !out.endsWith('\n') ? '\n' : ''; continue; }
    if (name === 'td' || name === 'th') { if (!closing && cell++) out += ' | '; continue; }
    if (name === 'a') {
      if (!closing) {
        let href: string | undefined;
        try { const url = new URL(attribute(attributes, 'href'), base); url.hash = ''; if (['http:', 'https:'].includes(url.protocol)) href = url.href; } catch { /* not a link we can offer */ }
        anchors.push({ start: out.length, href });
      } else {
        const anchor = anchors.pop();
        const text = anchor ? out.slice(anchor.start).trim() : '';
        if (anchor?.href && text && !pre) { out = `${out.slice(0, anchor.start)}[${text}](${anchor.href})`; links.add(anchor.href); }
      }
      continue;
    }
    if (blocks.has(name)) block();
  }
  const text = out.split('\n').map(line => pre ? line : line.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, links: [...links] };
}

/** Plain text and markdown pass through; the first heading, if any, is the title. */
export function extractText(text: string): Extracted {
  const links = [...new Set([...text.matchAll(/https?:\/\/[^\s<>()\[\]"'`]+/g)].map(match => match[0].replace(/[.,;:!?]+$/, '')))];
  return { title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? '', text: text.replace(/\r\n?/g, '\n').trim(), links };
}

const marker = '\n[truncated]';
/** Cuts text to at most maxChars, marker included, at a paragraph break when one is near and never through a surrogate pair. */
export function bound(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const room = Math.max(0, maxChars - marker.length);
  let end = text.lastIndexOf('\n\n', room);
  if (end < room * 0.7) end = room;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return { text: `${text.slice(0, end).trimEnd()}${marker}`, truncated: true };
}
