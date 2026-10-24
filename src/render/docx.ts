import { strToU8, zipSync } from 'fflate';
import { Lexer, type Token, type Tokens } from 'marked';
import { imageSize } from '../util/image-type';

/**
 * A note as a Word document (.docx), made from its Markdown (render/markdown.ts)
 * as render/html.ts makes a page: the YAML properties become a table, callouts
 * (`> [!type]- Title`) a shaded block with its title, and links to images the
 * note saved show the image, embedded in the document (png, jpg, gif; others stay
 * links). Links keep only http(s), mailto and relative targets, as on the page.
 * A .docx is a ZIP of XML parts; fflate packs it.
 */

/** Bytes of an image the note links to, by the link as written (`files/x.png`). */
export type DocxImages = (href: string) => Uint8Array | undefined;

const CALLOUT = /^> \[!(\w+)\][-+]? ?(.*)$/;
/** Images Word shows everywhere; webp, svg and others stay links. */
const EMBEDDED: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif' };
/** The text area of an A4 page with 2 cm margins, in EMU (1 cm = 360000). */
const MAX_WIDTH_EMU = 17 * 360000;
const MAX_HEIGHT_EMU = 25 * 360000;
const EMU_PER_PX = 9525;

/** Whether a Word note shows the file at `path` as an image (png, jpg, gif). */
export function embedsInWord(path: string): boolean {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase() in EMBEDDED;
}

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Text for XML: escaped, without the control characters XML does not allow. */
function xml(text: string): string {
  return (
    text
      // XML 1.0 does not allow these characters at all.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

/** Entities marked leaves in text (`&amp;` written in the Markdown). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    const named: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
    };
    return named[lower] ?? all;
  });
}

/** A link target the document may follow: web, mail or a file next to the note. */
function safeHref(href: string): string | null {
  const target = href.trim();
  if (/^(https?:|mailto:)/i.test(target)) return target;
  return /^[a-z][a-z0-9+.-]*:/i.test(target) ? null : target;
}

/** Run formatting, as it accumulates through nested inline tokens. */
interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

/** Paragraph context: inside a quote or a callout (its paragraph style), in a list at some level. */
interface Block {
  frame?: 'Quote' | 'Callout';
  list?: { num: number; level: number };
}

class DocxWriter {
  private readonly rels: string[] = [];
  private readonly media: Record<string, Uint8Array> = {};
  private readonly numbers: { ordered: boolean; start: number }[] = [];
  private drawings = 0;

  constructor(private readonly images: DocxImages) {}

  private rel(type: string, target: string, external: boolean): string {
    const id = `rId${this.rels.length + 10}`;
    this.rels.push(
      `<Relationship Id="${id}" Type="${REL}/${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`,
    );
    return id;
  }

  // Inline content.

  private run(text: string, style: RunStyle): string {
    const props = [
      style.link ? '<w:rStyle w:val="Hyperlink"/>' : '',
      style.code ? '<w:rStyle w:val="CodeChar"/>' : '',
      style.bold ? '<w:b/>' : '',
      style.italic ? '<w:i/>' : '',
      style.strike ? '<w:strike/>' : '',
    ].join('');
    const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
    // Line breaks and tabs are elements of their own in a run.
    const parts = text.split(/(\n|\t)/).map((part) => {
      if (part === '\n') return '<w:br/>';
      if (part === '\t') return '<w:tab/>';
      return part ? `<w:t xml:space="preserve">${xml(part)}</w:t>` : '';
    });
    return `<w:r>${rPr}${parts.join('')}</w:r>`;
  }

  /** The image a link points at, embedded; null when it is not one the note saved. */
  private picture(href: string, alt: string): string | null {
    const target = safeHref(href);
    if (!target || /^[a-z]+:/i.test(target)) return null;
    const path = target.split(/[?#]/)[0] ?? '';
    const ext = EMBEDDED[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
    if (!ext) return null;
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.images(decodeURI(path));
    } catch {
      bytes = this.images(path);
    }
    if (!bytes) return null;
    const read = imageSize(bytes);
    // A header with no size or a nonsense one: an ordinary picture's proportions.
    const size =
      read && read.width > 0 && read.height > 0 && read.width < 30000 && read.height < 30000
        ? read
        : { width: 640, height: 480 };
    const id = ++this.drawings;
    const name = `image${id}.${ext}`;
    this.media[`word/media/${name}`] = bytes;
    const rid = this.rel('image', `media/${name}`, false);
    let cx = size.width * EMU_PER_PX;
    let cy = size.height * EMU_PER_PX;
    const scale = Math.min(1, MAX_WIDTH_EMU / cx, MAX_HEIGHT_EMU / cy);
    cx = Math.round(cx * scale);
    cy = Math.round(cy * scale);
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${xml(alt)}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  }

  private inline(tokens: readonly Token[] | undefined, style: RunStyle = {}): string {
    let out = '';
    for (const token of tokens ?? []) {
      switch (token.type) {
        case 'strong':
          out += this.inline((token as Tokens.Strong).tokens, { ...style, bold: true });
          break;
        case 'em':
          out += this.inline((token as Tokens.Em).tokens, { ...style, italic: true });
          break;
        case 'del':
          out += this.inline((token as Tokens.Del).tokens, { ...style, strike: true });
          break;
        case 'codespan':
          out += this.run((token as Tokens.Codespan).text, { ...style, code: true });
          break;
        case 'br':
          out += '<w:r><w:br/></w:r>';
          break;
        case 'link': {
          const link = token as Tokens.Link;
          const picture = this.picture(link.href, link.text);
          if (picture) {
            out += picture;
            break;
          }
          const target = safeHref(link.href);
          const text = this.inline(link.tokens, target ? { ...style, link: true } : style);
          out += target
            ? `<w:hyperlink r:id="${this.rel('hyperlink', target, true)}">${text}</w:hyperlink>`
            : text;
          break;
        }
        case 'image': {
          const image = token as Tokens.Image;
          out += this.picture(image.href, image.text) ?? this.run(image.text, style);
          break;
        }
        case 'checkbox':
          out += this.run((token as Tokens.Checkbox).checked ? '☑ ' : '☐ ', style);
          break;
        case 'text': {
          const text = token as Tokens.Text;
          out += text.tokens?.length
            ? this.inline(text.tokens, style)
            : this.run(decodeEntities(text.text), style);
          break;
        }
        default:
          // escape, html (shown as text, as on the page) and anything else: its text.
          out += this.run('text' in token ? decodeEntities(String(token.text)) : '', style);
      }
    }
    return out;
  }

  // Blocks.

  private paragraph(content: string, block: Block, style?: string, extra = ''): string {
    const props = [
      (style ?? block.frame) ? `<w:pStyle w:val="${style ?? block.frame}"/>` : '',
      block.list
        ? `<w:numPr><w:ilvl w:val="${block.list.level}"/><w:numId w:val="${block.list.num}"/></w:numPr>`
        : '',
      extra,
    ].join('');
    return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
  }

  private list(list: Tokens.List, block: Block): string {
    const level = block.list ? block.list.level + 1 : 0;
    this.numbers.push({ ordered: list.ordered, start: Number(list.start) || 1 });
    const num = this.numbers.length;
    let out = '';
    for (const item of list.items) {
      // The first paragraph carries the number; the rest of the item is indented under it.
      let first = true;
      let lead = '';
      for (const token of item.tokens) {
        if (token.type === 'checkbox') {
          lead += this.inline([token]);
          continue;
        }
        if (first && (token.type === 'text' || token.type === 'paragraph')) {
          const tokens = (token as Tokens.Text | Tokens.Paragraph).tokens ?? [token];
          out += this.paragraph(lead + this.inline(tokens), { ...block, list: { num, level } });
          first = false;
          continue;
        }
        if (first) {
          out += this.paragraph(lead, { ...block, list: { num, level } });
          first = false;
        }
        out += this.blocks([token], { ...block, list: { num, level } }, true);
      }
      if (first) out += this.paragraph(lead, { ...block, list: { num, level } });
    }
    return out;
  }

  private table(table: Tokens.Table, block: Block): string {
    const cell = (c: Tokens.TableCell, header: boolean) =>
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${this.paragraph(
        this.inline(c.tokens, header ? { bold: true } : {}),
        block.frame ? { frame: block.frame } : {},
        undefined,
        c.align
          ? `<w:jc w:val="${c.align === 'center' ? 'center' : c.align === 'right' ? 'right' : 'left'}"/>`
          : '',
      )}</w:tc>`;
    const row = (cells: Tokens.TableCell[], header: boolean) =>
      `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((c) => cell(c, header)).join('')}</w:tr>`;
    return (
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
      `${row(table.header, true)}${table.rows.map((r) => row(r, false)).join('')}</w:tbl>` +
      // Word needs a paragraph between two tables, and one after a table in a cell.
      this.paragraph('', {})
    );
  }

  /** `inItem`: the blocks continue a list item, indented under its number. */
  blocks(tokens: readonly Token[], block: Block = {}, inItem = false): string {
    let out = '';
    const indent = inItem && block.list ? `<w:ind w:left="${720 * (block.list.level + 1)}"/>` : '';
    const plain: Block = block.frame ? { frame: block.frame } : {};
    for (const token of tokens) {
      switch (token.type) {
        case 'heading': {
          const heading = token as Tokens.Heading;
          out += this.paragraph(
            this.inline(heading.tokens),
            plain,
            `Heading${Math.min(heading.depth, 6)}`,
          );
          break;
        }
        case 'paragraph':
          out += this.paragraph(
            this.inline((token as Tokens.Paragraph).tokens),
            plain,
            undefined,
            indent,
          );
          break;
        case 'text': {
          const text = token as Tokens.Text;
          out += this.paragraph(this.inline(text.tokens ?? [text]), plain, undefined, indent);
          break;
        }
        case 'code':
          out += this.paragraph(this.run((token as Tokens.Code).text, {}), plain, 'Code', indent);
          break;
        case 'blockquote':
          out += this.blocks(
            (token as Tokens.Blockquote).tokens,
            { ...block, frame: block.frame ?? 'Quote' },
            inItem,
          );
          break;
        case 'list':
          out += this.list(token as Tokens.List, block);
          break;
        case 'table':
          out += this.table(token as Tokens.Table, block);
          break;
        case 'hr':
          out += this.paragraph('', plain, 'Rule');
          break;
        case 'html':
          out += this.paragraph(
            this.run((token as Tokens.HTML).text.trim(), {}),
            plain,
            undefined,
            indent,
          );
          break;
        default:
          // space and anything without content.
          break;
      }
    }
    return out;
  }

  callout(title: string, inner: string): string {
    const head = this.paragraph(this.inline(new Lexer().inlineTokens(title)), {}, 'CalloutTitle');
    return head + this.blocks(new Lexer({ gfm: true }).lex(inner), { frame: 'Callout' });
  }

  properties(rows: [string, string][]): string {
    if (!rows.length) return '';
    const cell = (text: string) =>
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="Property"/></w:pPr>${this.run(text, {})}</w:p></w:tc>`;
    return (
      `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="0000"/></w:tblPr>` +
      rows.map(([k, v]) => `<w:tr>${cell(k)}${cell(v)}</w:tr>`).join('') +
      `</w:tbl>${this.paragraph('', {})}`
    );
  }

  package(body: string, title: string): Uint8Array {
    const document =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
      `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>` +
      `</w:sectPr></w:body></w:document>`;
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(ROOT_RELS),
      'docProps/core.xml': strToU8(core(title)),
      'word/document.xml': strToU8(document),
      'word/styles.xml': strToU8(STYLES),
      'word/numbering.xml': strToU8(numbering(this.numbers)),
      'word/_rels/document.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
          `<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>` +
          `${this.rels.join('')}</Relationships>`,
      ),
      ...this.media,
    };
    // Images are compressed already: stored, the rest deflated.
    return zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, data]) => [
          path,
          [data, { level: path.startsWith('word/media/') ? 0 : 6 }],
        ]),
      ),
    );
  }
}

/** `key: value` lines of the YAML front matter, as render/html.ts reads them. */
function frontMatter(yaml: string): [string, string][] {
  return yaml
    .split('\n')
    .map((line): [string, string] | null => {
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      if (!m?.[1]) return null;
      const raw = m[2] ?? '';
      let value = raw;
      if (raw === 'null') value = '';
      else if (raw.startsWith('"')) {
        try {
          value = JSON.parse(raw) as string;
        } catch {
          value = raw;
        }
      } else if (raw.startsWith('[')) value = raw.slice(1, -1);
      return [m[1], value];
    })
    .filter((p): p is [string, string] => p !== null && p[1] !== '');
}

/** The Word document for a note's Markdown. */
export function renderDocx(markdown: string, title: string, images: DocxImages): Uint8Array {
  const writer = new DocxWriter(images);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  const rest = front ? markdown.slice(front[0].length) : markdown;
  let body = front ? writer.properties(frontMatter(front[1] ?? '')) : '';

  const plain: string[] = [];
  const flush = () => {
    if (plain.length) body += writer.blocks(new Lexer({ gfm: true }).lex(plain.join('\n')));
    plain.length = 0;
  };
  const lines = rest.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = CALLOUT.exec(lines[i] ?? '');
    if (!head) {
      plain.push(lines[i] ?? '');
      continue;
    }
    flush();
    const inner: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]?.startsWith('>')) {
      inner.push((lines[++i] ?? '').replace(/^> ?/, ''));
    }
    body += writer.callout(head[2] ?? '', inner.join('\n'));
  }
  flush();
  return writer.package(body, title);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

function core(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title></cp:coreProperties>`;
}

/** Bullets for unordered lists, numbers for ordered ones; each list restarts at its start. */
function numbering(lists: { ordered: boolean; start: number }[]): string {
  const levels = (ordered: boolean) =>
    Array.from({ length: 9 }, (_, level) => {
      const format = ordered ? ['decimal', 'lowerLetter', 'lowerRoman'][level % 3] : 'bullet';
      const text = ordered ? `%${level + 1}.` : ['•', '◦', '▪'][level % 3];
      return (
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
        `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
      );
    }).join('');
  const nums = lists
    .map(
      (list, i) =>
        `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${list.ordered ? 1 : 0}"/>` +
        `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${list.start}"/></w:lvlOverride></w:num>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>${nums}</w:numbering>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:pBdr><w:top w:val="single" w:sz="4" w:space="8" w:color="D9D9D9"/></w:pBdr><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Heading3"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Heading4"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Heading5"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="5"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F5"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/><w:ind w:left="113" w:right="113"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Inline code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F3F3F5"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D9D9D9"/></w:pBdr><w:ind w:left="284"/></w:pPr><w:rPr><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Callout"><w:name w:val="Callout"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="1F6FEB"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F7"/><w:ind w:left="284"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="CalloutTitle"><w:name w:val="Callout title"/><w:basedOn w:val="Callout"/><w:next w:val="Callout"/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Property"><w:name w:val="Property"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:ind w:right="284"/></w:pPr><w:rPr><w:color w:val="6B6B70"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Rule"><w:name w:val="Rule"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9D9D9"/></w:pBdr></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F6FEB"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
