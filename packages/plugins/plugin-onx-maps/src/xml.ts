/**
 * Minimal non-validating XML reader for GPX and KML.
 *
 * Deliberately dependency-free. It is also deliberately *incapable* of
 * entity expansion: `<!DOCTYPE …>` is skipped without parsing its internal
 * subset, and only the five predefined entities plus numeric character
 * references are resolved. An uploaded file therefore cannot declare an
 * entity at all, which rules out XXE and billion-laughs expansion by
 * construction rather than by limit-checking.
 *
 * Parsing is iterative (explicit stack) so a pathologically deep document
 * cannot blow the call stack.
 */

export interface XmlNode {
  /** Tag name with any namespace prefix stripped, lowercased. */
  name: string;
  /** Attribute names have their namespace prefix stripped and are lowercased. */
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content, entity-decoded and trimmed. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlText(input: string): string {
  if (!input.includes("&")) return input;

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      // Lone surrogates are not valid scalar values and throw in fromCodePoint.
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    // An undeclared entity is left verbatim rather than resolved or expanded.
    return named ?? match;
  });
}

/** Strip a namespace prefix (`kml:Placemark` → `placemark`). */
function localName(raw: string): string {
  const colon = raw.lastIndexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const value = match[3] !== undefined ? match[3] : (match[4] ?? "");
    attributes[localName(match[1]!)] = decodeXmlText(value);
  }
  return attributes;
}

export class XmlParseError extends Error {}

/**
 * Parse a document and return its root element.
 *
 * @throws {XmlParseError} when the document has no root element or the tag
 *   structure does not nest correctly.
 */
export function parseXml(input: string): XmlNode {
  // A UTF-8 BOM survives Buffer→string conversion and would otherwise be
  // treated as leading text before the root element.
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let cursor = 0;

  const appendText = (raw: string): void => {
    const parent = stack[stack.length - 1];
    if (!parent || raw.length === 0) return;
    parent.text += raw;
  };

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) {
      appendText(decodeXmlText(source.slice(cursor)));
      break;
    }

    if (open > cursor) {
      appendText(decodeXmlText(source.slice(cursor, open)));
    }

    // Comment
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }

    // CDATA — content is taken verbatim, never entity-decoded.
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      const stop = end === -1 ? source.length : end;
      appendText(source.slice(open + 9, stop));
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }

    // DOCTYPE — skipped wholesale, including any internal subset. Nothing
    // inside it is ever interpreted, which is what makes entity attacks moot.
    if (/^<!doctype/i.test(source.slice(open, open + 9))) {
      let depth = 0;
      let index = open;
      for (; index < source.length; index += 1) {
        const char = source[index];
        if (char === "<") depth += 1;
        else if (char === ">") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      cursor = index + 1;
      continue;
    }

    // Processing instruction / XML declaration
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }

    const close = source.indexOf(">", open);
    if (close === -1) {
      appendText(decodeXmlText(source.slice(open)));
      break;
    }

    const rawTag = source.slice(open + 1, close);

    // Closing tag
    if (rawTag.startsWith("/")) {
      const name = localName(rawTag.slice(1).trim());
      const current = stack[stack.length - 1];
      if (!current) {
        throw new XmlParseError(`Unexpected closing tag </${name}> with no open element`);
      }
      if (current.name !== name) {
        throw new XmlParseError(
          `Mismatched closing tag: expected </${current.name}>, found </${name}>`,
        );
      }
      current.text = current.text.trim();
      stack.pop();
      cursor = close + 1;
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const nameEnd = body.search(/[\s/]/);
    const name = localName(nameEnd === -1 ? body : body.slice(0, nameEnd));
    if (name.length === 0) {
      throw new XmlParseError("Encountered a tag with an empty name");
    }

    const node: XmlNode = {
      name,
      attributes: nameEnd === -1 ? {} : parseAttributes(body.slice(nameEnd)),
      children: [],
      text: "",
    };

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else if (root) {
      throw new XmlParseError("Document has more than one root element");
    } else {
      root = node;
    }

    if (!selfClosing) {
      stack.push(node);
    }

    cursor = close + 1;
  }

  if (stack.length > 0) {
    throw new XmlParseError(`Unclosed element <${stack[stack.length - 1]!.name}>`);
  }
  if (!root) {
    throw new XmlParseError("Document contains no root element");
  }
  return root;
}

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

export function firstChild(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((child) => child.name === name) ?? null;
}

/** Trimmed text of the first matching child, or null when absent/empty. */
export function childText(node: XmlNode, name: string): string | null {
  const child = firstChild(node, name);
  if (!child) return null;
  const value = child.text.trim();
  return value.length > 0 ? value : null;
}

export function childNumber(node: XmlNode, name: string): number | null {
  const value = childText(node, name);
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
