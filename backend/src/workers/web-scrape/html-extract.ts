/**
 * Enough of an HTML reader to answer "what is this page", and no more.
 */

export interface PageSummary {
  title: string | null;
  description: string | null;
  h1: string | null;
  links: number;
  words: number;
}

const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const H1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const META_TAG = /<meta\b[^>]*>/gi;
const ANCHOR_WITH_HREF = /<a\b[^>]*\shref\s*=/gi;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const ANY_TAG = /<[^>]*>/g;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};
/** One pass, so a decoded `&amp;` cannot be re-read as the start of another entity. */
const ENTITY = /&(?:amp|lt|gt|quot|nbsp|#39|#x27);/gi;

export function extractPage(html: string): PageSummary {
  const text = html.replace(COMMENT, ' ').replace(SCRIPT_OR_STYLE, ' ').replace(ANY_TAG, ' ');

  return {
    title: clean(TITLE.exec(html)?.[1]),
    description: metaContent(html, 'description') ?? metaContent(html, 'og:description'),
    h1: clean(H1.exec(html)?.[1]),
    links: [...html.matchAll(ANCHOR_WITH_HREF)].length,
    words: decode(text).split(/\s+/).filter(Boolean).length,
  };
}

function metaContent(html: string, key: string): string | null {
  for (const [tag] of html.matchAll(META_TAG)) {
    const name = attribute(tag, 'name') ?? attribute(tag, 'property');
    if (name?.trim().toLowerCase() === key) {
      const content = clean(attribute(tag, 'content'));
      if (content) {
        return content;
      }
    }
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(tag);
  if (!match) {
    return null;
  }
  return match[1] ?? match[2] ?? match[3] ?? null;
}

const decode = (value: string): string =>
  value.replace(ENTITY, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const collapsed = decode(value.replace(ANY_TAG, ' ')).replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}
