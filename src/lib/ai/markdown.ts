/**
 * Lightweight, XSS-safe GitHub-Flavored Markdown renderer tailored for trading
 * analysis output (headings, tables, lists, code, blockquotes, links, bias pills).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed);
}

function renderBoldWithBias(inner: string): string {
  const upper = inner.trim().toUpperCase();
  if (upper === 'BULLISH' || upper === 'STRONG BUY' || upper === 'BUY') {
    return `<strong class="ai-bias-bull">${inner}</strong>`;
  }
  if (upper === 'BEARISH' || upper === 'STRONG SELL' || upper === 'SELL') {
    return `<strong class="ai-bias-bear">${inner}</strong>`;
  }
  if (upper === 'NEUTRAL' || upper === 'WAIT' || upper === 'RANGING') {
    return `<strong class="ai-bias-neutral">${inner}</strong>`;
  }
  return `<strong>${inner}</strong>`;
}

function renderInline(raw: string): string {
  const codeSpans: string[] = [];
  let text = escapeHtml(raw);

  // Extract inline code first so formatting inside backticks is untouched
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // Links [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    if (!isSafeUrl(cleanUrl)) return label;
    return `<a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bold **text** or __text__ (non-greedy so inline symbols never break matching)
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) => renderBoldWithBias(inner));
  text = text.replace(/__(.+?)__/g, (_m, inner: string) => renderBoldWithBias(inner));

  // Italic *text*
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // Strikethrough ~~text~~
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Restore inline code
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idxStr: string) => codeSpans[Number(idxStr)] ?? '');

  return text;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function parseAlignments(sepLine: string): Array<'left' | 'center' | 'right'> {
  return splitTableRow(sepLine).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

export function renderMarkdown(source: string): string {
  if (!source) return '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block ```
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      html.push('<hr />');
      i += 1;
      continue;
    }

    // Headings # .. ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
      html.push(`<${tag}>${renderInline(headingMatch[2])}</${tag}>`);
      i += 1;
      continue;
    }

    // GFM Table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(lines[i]);
      const aligns = parseAlignments(lines[i + 1]);
      i += 2;

      const bodyRows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes('|')) break;
        bodyRows.push(splitTableRow(rowLine));
        i += 1;
      }

      const ths = headers
        .map((h, idx) => `<th style="text-align:${aligns[idx] ?? 'left'}">${renderInline(h)}</th>`)
        .join('');
      const trs = bodyRows
        .map((row) => {
          const tds = headers
            .map(
              (_h, idx) =>
                `<td style="text-align:${aligns[idx] ?? 'left'}">${renderInline(row[idx] ?? '')}</td>`
            )
            .join('');
          return `<tr>${tds}</tr>`;
        })
        .join('');

      html.push(
        `<div class="md-table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`
      );
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${quoteLines.map((l) => renderInline(l)).join('<br />')}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    // Paragraph (coalesce consecutive plain lines)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (
        !curTrim ||
        curTrim.startsWith('```') ||
        /^#{1,4}\s+/.test(curTrim) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(curTrim) ||
        curTrim.startsWith('>') ||
        /^[-*+]\s+/.test(curTrim) ||
        /^\d+\.\s+/.test(curTrim) ||
        (curTrim.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(curTrim);
      i += 1;
    }

    html.push(`<p>${paraLines.map((l) => renderInline(l)).join('<br />')}</p>`);
  }

  return html.join('');
}

function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

/**
 * Converts Markdown AI output into clean, readable plain text for the plain-text Notes editor
 * (no raw #, **, or |---| table syntax).
 */
export function markdownToCleanText(source: string): string {
  if (!source) return '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1] !== '') {
        out.push('');
      }
      i += 1;
      continue;
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        out.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      continue;
    }

    // Horizontal rule -> blank separator
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      i += 1;
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(stripInlineMarkdown(headingMatch[1]));
      i += 1;
      continue;
    }

    // GFM Table -> clean bulleted rows without raw pipes
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(lines[i]).map((h) => stripInlineMarkdown(h));
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes('|')) break;
        const cells = splitTableRow(rowLine).map((c) => stripInlineMarkdown(c));
        const first = cells[0] ?? '';
        const rest: string[] = [];
        for (let c = 1; c < cells.length; c++) {
          const val = cells[c];
          if (!val || val === '-' || val === '—') continue;
          const label = headers[c];
          rest.push(label ? `${label}: ${val}` : val);
        }
        if (first && rest.length > 0) {
          out.push(`• ${first} — ${rest.join(' · ')}`);
        } else if (first) {
          out.push(`• ${first}`);
        } else if (rest.length > 0) {
          out.push(`• ${rest.join(' · ')}`);
        }
        i += 1;
      }
      out.push('');
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      out.push(stripInlineMarkdown(trimmed.replace(/^>\s?/, '')));
      i += 1;
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      out.push(`• ${stripInlineMarkdown(trimmed.replace(/^[-*+]\s+/, ''))}`);
      i += 1;
      continue;
    }

    // Ordered list
    const orderedMatch = trimmed.match(/^(\d+\.)\s+(.+)$/);
    if (orderedMatch) {
      out.push(`${orderedMatch[1]} ${stripInlineMarkdown(orderedMatch[2])}`);
      i += 1;
      continue;
    }

    out.push(stripInlineMarkdown(trimmed));
    i += 1;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
