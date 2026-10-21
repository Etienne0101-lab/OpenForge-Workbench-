// Lightweight, dependency-free Markdown rendering for assistant output.
//
// The previous renderer printed line-by-line paragraphs, so headings, lists,
// tables, and emphasis from the model were lost. This module renders a
// practical Markdown subset to React nodes (never innerHTML): headings,
// paragraphs, bold/italic/strikethrough, inline code, links, unordered /
// ordered / task lists, blockquotes, horizontal rules, tables, and fenced
// code blocks with a language label, copy button, download button, syntax
// highlighting, and collapse for long blocks.

import { useState } from 'react';
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/* Syntax highlighting (shared with the change-set previews)           */
/* ------------------------------------------------------------------ */

const CODE_TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|elif|for|while|do|import|from|export|default|class|extends|implements|new|delete|async|await|try|except|catch|finally|throw|raise|typeof|instanceof|in|of|switch|case|break|continue|def|print|None|True|False|lambda|with|as|pass|yield|global|public|private|protected|static|void|fn|pub|struct|impl|trait|match|mut|package|func|go|defer|type|interface|enum|record|sealed|data|object|val|vararg|when|namespace|using|bool|int|float|double|string|char|long|short|byte|select|where|group|by|join|on|union|create|table|insert|update|values|into)\b|\b(\d[\d_]*(?:\.\d+)?)\b/g;

export function highlightCode(code: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_TOKEN_RE.exec(code)) !== null) {
    if (match.index > last) nodes.push(code.slice(last, match.index));
    const cls = match[1] ? 'tok-com' : match[2] ? 'tok-str' : match[3] ? 'tok-kw' : 'tok-num';
    nodes.push(<span key={key++} className={cls}>{match[0]}</span>);
    last = match.index + match[0].length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Inline formatting                                                   */
/* ------------------------------------------------------------------ */

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  // NOTE: the regex is created per call on purpose — renderInline recurses
  // for nested emphasis, and a shared /g regex would have its lastIndex
  // clobbered by the inner call, looping the outer scan forever.
  const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:https?|mailto):[^)\s]+\))|(https?:\/\/[^\s)]+)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  const pushPlain = (chunk: string) => {
    if (chunk) nodes.push(chunk);
  };
  while ((match = INLINE_RE.exec(text)) !== null) {
    pushPlain(text.slice(last, match.index));
    const token = match[0];
    const k = `${keyPrefix}-${key++}`;
    if (match[1]) {
      nodes.push(<code key={k}>{token.slice(1, -1)}</code>);
    } else if (match[2] || match[3]) {
      nodes.push(<strong key={k}>{renderInline(token.slice(2, -2), k)}</strong>);
    } else if (match[4]) {
      nodes.push(<del key={k}>{renderInline(token.slice(2, -2), k)}</del>);
    } else if (match[5]) {
      nodes.push(<em key={k}>{renderInline(token.slice(1, -1), k)}</em>);
    } else if (match[6]) {
      const labelEnd = token.indexOf('](');
      const label = token.slice(1, labelEnd);
      const url = token.slice(labelEnd + 2, -1);
      nodes.push(<a key={k} href={url} target="_blank" rel="noreferrer">{label}</a>);
    } else if (match[7]) {
      nodes.push(<a key={k} href={token} target="_blank" rel="noreferrer">{token}</a>);
    }
    last = match.index + token.length;
  }
  pushPlain(text.slice(last));
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Code blocks with chrome                                             */
/* ------------------------------------------------------------------ */

const LANG_EXT: Record<string, string> = {
  ts: 'ts', typescript: 'ts', tsx: 'tsx', js: 'js', javascript: 'js', jsx: 'jsx',
  py: 'py', python: 'py', json: 'json', sh: 'sh', bash: 'sh', shell: 'sh',
  yaml: 'yml', yml: 'yml', toml: 'toml', html: 'html', css: 'css', sql: 'sql',
  go: 'go', rust: 'rs', rs: 'rs', java: 'java', c: 'c', cpp: 'cpp', cs: 'cs',
  ruby: 'rb', rb: 'rb', php: 'php', swift: 'swift', kotlin: 'kt', md: 'md', markdown: 'md',
};

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');
  const long = lines.length > 24;
  const visible = long && !expanded ? lines.slice(0, 24).join('\n') : code;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable; selection still works manually.
    }
  };
  const download = () => {
    const ext = LANG_EXT[language.toLowerCase()] || 'txt';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `snippet.${ext}`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{language || 'code'} · {lines.length} line{lines.length === 1 ? '' : 's'}</span>
        <span className="md-code-actions">
          <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" onClick={download}>Download</button>
        </span>
      </div>
      <pre><code>{highlightCode(visible)}</code></pre>
      {long && <button type="button" className="md-code-more" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Block-level parsing                                                 */
/* ------------------------------------------------------------------ */

function splitTableRow(row: string): string[] {
  return row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

export function Markdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nextKey = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push(<CodeBlock key={nextKey()} language={fence[1]} code={buffer.join('\n')} />);
      continue;
    }

    // Blank line
    if (!line.trim()) { i += 1; continue; }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = (`h${level}`) as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={nextKey()}>{renderInline(heading[2])}</Tag>);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} />);
      i += 1;
      continue;
    }

    // Table (header row + separator row)
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div className="md-table-wrap" key={nextKey()}>
          <table>
            <thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] || '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(<blockquote key={nextKey()}>{quoted.map((quotedLine, quoteIndex) => <p key={quoteIndex}>{renderInline(quotedLine)}</p>)}</blockquote>);
      continue;
    }

    // Unordered / task list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Array<{ text: string; checked: boolean | null; indent: number }> = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const raw = lines[i];
        const indent = raw.length - raw.trimStart().length;
        let text = raw.replace(/^\s*[-*+]\s+/, '');
        let checked: boolean | null = null;
        const task = /^\[([ xX])\]\s+/.exec(text);
        if (task) {
          checked = task[1].toLowerCase() === 'x';
          text = text.replace(/^\[[ xX]\]\s+/, '');
        }
        items.push({ text, checked, indent });
        i += 1;
      }
      blocks.push(
        <ul key={nextKey()}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex} className={item.indent >= 2 ? 'nested' : undefined}>
              {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly />}
              {renderInline(item.text)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push(<ol key={nextKey()}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>);
      continue;
    }

    // Paragraph: gather until a blank line or another block start
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={nextKey()}>{renderInline(paragraph.join(' '))}</p>);
  }

  return <div className="message-body">{blocks}</div>;
}
