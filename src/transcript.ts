/**
 * Turns agent transcripts (JSONL) into compact text for the extractor.
 * Understands Claude Code and Codex natively; anything else falls back to role/text pairs.
 */

const ITEM_MAX = 1_500;
const RESULT_MAX = 300;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}…[${s.length - max} more chars]`);
const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

/** Hivemind's own tools and injected context are already in the plan; don't re-extract them. */
const isOwnTool = (name: string) => /hivemind/.test(name);
const isInjected = (text: string) => text.startsWith('[hivemind]') || text.startsWith('<');

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

function describeToolInput(name: string, input: Record<string, unknown>): string {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (/^(Edit|MultiEdit)$/.test(name)) return `${file}\n- ${clip(asText(input.old_string), 400)}\n+ ${clip(asText(input.new_string), 800)}`;
  if (name === 'Write') return `${file}\n${clip(asText(input.content), ITEM_MAX)}`;
  if (name === 'Bash') return asText(input.command);
  return clip(JSON.stringify(input), 500);
}

function renderClaude(d: any, out: string[], toolNames: Map<string, string>): void {
  if (d.isSidechain) return;
  const content = d.message?.content;
  if (d.type === 'user') {
    if (typeof content === 'string') {
      if (!isInjected(content)) out.push(`USER: ${clip(content, ITEM_MAX)}`);
      return;
    }
    for (const c of content ?? []) {
      if (c.type === 'text' && !isInjected(c.text)) out.push(`USER: ${clip(c.text, ITEM_MAX)}`);
      if (c.type === 'tool_result' && !isOwnTool(toolNames.get(c.tool_use_id) ?? '')) {
        out.push(`RESULT: ${clip(textOf(c.content), RESULT_MAX)}`);
      }
    }
  } else if (d.type === 'assistant') {
    for (const c of content ?? []) {
      if (c.type === 'text') out.push(`ASSISTANT: ${clip(c.text, ITEM_MAX)}`);
      if (c.type === 'tool_use') {
        toolNames.set(c.id, c.name);
        if (!isOwnTool(c.name)) out.push(`TOOL ${c.name}: ${describeToolInput(c.name, c.input ?? {})}`);
      }
    }
  }
}

function renderCodex(p: any, out: string[], toolNames: Map<string, string>): void {
  switch (p.type) {
    case 'message': {
      if (p.role !== 'user' && p.role !== 'assistant') return;
      const t = textOf(p.content);
      if (t && !isInjected(t)) out.push(`${p.role.toUpperCase()}: ${clip(t, ITEM_MAX)}`);
      return;
    }
    case 'function_call':
    case 'custom_tool_call': {
      toolNames.set(p.call_id, p.name);
      if (!isOwnTool(p.name)) out.push(`TOOL ${p.name}: ${clip(asText(p.arguments ?? p.input), ITEM_MAX)}`);
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      if (!isOwnTool(toolNames.get(p.call_id) ?? '')) out.push(`RESULT: ${clip(asText(p.output), RESULT_MAX)}`);
  }
}

function renderGeneric(d: any, out: string[]): void {
  const role = d.role ?? d.message?.role ?? d.type;
  const t = textOf(d.content ?? d.message?.content ?? d.text);
  if (role && t && !isInjected(t)) out.push(`${String(role).toUpperCase()}: ${clip(t, ITEM_MAX)}`);
}

export function renderTranscript(lines: string[], maxChars = 24_000): string {
  const out: string[] = [];
  const toolNames = new Map<string, string>();
  for (const line of lines) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'user' || d.type === 'assistant') renderClaude(d, out, toolNames);
    else if (d.type === 'response_item' && d.payload) renderCodex(d.payload, out, toolNames);
    else if (d.type !== 'event_msg' && d.type !== 'turn_context') renderGeneric(d, out);
  }
  const text = out.join('\n');
  // Keep the most recent part: it reflects the current state of the work.
  return text.length <= maxChars ? text : `…\n${text.slice(text.length - maxChars)}`;
}

/** Worth spending a model call on? Needs a user request or a code change, not just reads. */
export function isSubstantive(rendered: string): boolean {
  return /^(USER:|TOOL (Edit|MultiEdit|Write|Bash|apply_patch|exec|shell))/m.test(rendered) || /^ASSISTANT: .{200,}/m.test(rendered);
}
