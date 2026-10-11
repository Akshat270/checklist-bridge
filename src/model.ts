// Checklist data model and Claude's tools. Pure Node, no `vscode` import, so it can be tested directly.
import { randomUUID } from 'crypto';

export interface Img { id: string; mime: string; data: string; w: number; h: number }
export interface Draft { done: boolean; note: string; images: Img[] }
export interface Shared { at: number; done: boolean; note: string; images: Img[] }

export interface Task {
  id: string;
  text: string;
  detail?: string;
  command?: string;
  tags: string[];
  group?: string;
  addedAt: number;
  /** Bumped whenever the task changes in a way the panel must re-render. */
  rev: number;
  draft: Draft;
  shared?: Shared;
  /** When Claude last read this task's shared state. */
  seenAt?: number;
  /** User took back a task Claude had already seen; reported once on the next read. */
  withdrawn?: boolean;
}

export interface Checklist {
  id: string;
  sessionId: string;
  title: string;
  folder: string;
  createdAt: number;
  updatedAt: number;
  nextId: number;
  tasks: Task[];
  groupOrder: string[];
  hidden: boolean;
  closed: boolean;
  lastReadAt?: number;
}

export interface CallMeta { cwd?: string; client?: string }

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { content: Content[]; isError?: boolean }

export type ChangeKind = 'created' | 'tasks-added' | 'updated' | 'closed' | 'removed';
export interface ChangeEvent { checklist: Checklist; kind: ChangeKind; added?: number }

const MAX_IMAGES_PER_READ = 8;
const MAX_TASKS_PER_CALL = 40;
const str = (v: unknown, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const cleanTags = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.map((t) => str(t, 32)?.toLowerCase().replace(/\s+/g, '-')).filter((t): t is string => !!t))].slice(0, 6)
    : [];

/* ------------------------------------------------------------------ tool definitions */

const taskSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'One concrete action, phrased as an instruction ("Create a Supabase project in the Mumbai region").' },
    detail: { type: 'string', description: 'Optional: where to find things, what to look out for.' },
    command: { type: 'string', description: 'Optional: exact command or value to copy.' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional labels. "urgent", "important", "optional", "quick" and "blocked" are styled specially; any other short word works too.',
    },
    group: { type: 'string', description: 'Optional section name, e.g. "Database" or "Deploy". Tasks with the same group are shown together.' },
  },
  required: ['text'],
};

export const TOOLS = [
  {
    name: 'checklist_add_tasks',
    title: 'Add tasks to the user\'s checklist',
    description:
      'Adds tasks for THE USER to do by hand (run a command, change a setting, click through a website/dashboard, create a key, ' +
      'test something, give you a value) to this chat\'s checklist in VS Code. The first call opens the checklist; later calls add to it. ' +
      'It does NOT wait: the user works through tasks at their own pace while you keep talking. Do not also list these steps in your reply; ' +
      'just say briefly that you added them. You only learn what happened via checklist_read.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short checklist title (only used/changed if given), e.g. "Supabase setup".' },
        tasks: { type: 'array', minItems: 1, maxItems: MAX_TASKS_PER_CALL, items: taskSchema },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'checklist_read',
    title: 'Read what the user has shared',
    description:
      'Returns the tasks the user has SHARED with you (done or not done, with their notes and screenshots). Tasks the user has not ' +
      'shared yet are listed only as waiting: you cannot see whether they are ticked. Call this at the start of every reply while ' +
      'this chat has a checklist with waiting tasks, and before you rely on any manual step. Never assume a waiting task was done.',
    inputSchema: {
      type: 'object',
      properties: {
        include_earlier_images: { type: 'boolean', description: 'Also re-send images from tasks you have already read. Default false.' },
      },
    },
  },
  {
    name: 'checklist_edit',
    title: 'Edit, tag, group or remove tasks',
    description:
      'Changes tasks already on this chat\'s checklist: rename the checklist, change a task\'s wording, add/remove tags ' +
      '(e.g. mark something "urgent" or "important"), move tasks into groups, reorder groups, or remove tasks that are no longer needed. ' +
      'Wording of a task the user already shared cannot be changed; tags and group can.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Task id, e.g. "t3".' },
              text: { type: 'string' },
              detail: { type: 'string', description: 'Empty string removes it.' },
              command: { type: 'string', description: 'Empty string removes it.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags.' },
              add_tags: { type: 'array', items: { type: 'string' } },
              remove_tags: { type: 'array', items: { type: 'string' } },
              group: { type: 'string', description: 'Empty string removes the task from its group.' },
            },
            required: ['id'],
          },
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks to delete.' },
        group_order: { type: 'array', items: { type: 'string' }, description: 'Group names in the order they should appear.' },
      },
    },
  },
];

export const SERVER_INSTRUCTIONS =
  'This server gives each chat a checklist in the user\'s VS Code. Whenever you need the user to do something by hand ' +
  '(run a command, set an env var, create an account or API key, click through a dashboard, test a page, tell you a value), ' +
  'add it with checklist_add_tasks instead of writing the steps in your reply, then keep working on whatever you can. ' +
  'The user shares tasks one at a time when they are ready, with notes and screenshots. While this chat\'s checklist has ' +
  'waiting tasks, call checklist_read at the start of each reply to pick up what they shared. Use tags such as "urgent" or ' +
  '"important" and groups to keep longer lists readable.';

/* ------------------------------------------------------------------ store */

export class ChecklistStore {
  private lists = new Map<string, Checklist>();
  private listeners: ((e: ChangeEvent) => void)[] = [];

  constructor(initial: Checklist[] = []) {
    for (const c of initial) this.lists.set(c.id, c);
  }

  onChange(fn: (e: ChangeEvent) => void) {
    this.listeners.push(fn);
  }
  private emit(e: ChangeEvent) {
    e.checklist.updatedAt = Date.now();
    for (const l of this.listeners) l(e);
  }

  all(): Checklist[] {
    return [...this.lists.values()].filter((c) => !c.closed).sort((a, b) => a.createdAt - b.createdAt);
  }
  get(id: string) {
    return this.lists.get(id);
  }
  /** Latest checklist for a chat, including a closed one (so Claude can be told it was closed). */
  private forSession(sessionId: string): Checklist | undefined {
    let found: Checklist | undefined;
    for (const c of this.lists.values()) if (c.sessionId === sessionId && (!found || c.createdAt > found.createdAt)) found = c;
    return found;
  }

  /* ---------- actions from the panel (the user) ---------- */

  private task(listId: string, taskId: string) {
    const c = this.lists.get(listId);
    const t = c?.tasks.find((x) => x.id === taskId);
    return c && t ? { c, t } : undefined;
  }

  /** Draft changes (tick / note) are saved without re-rendering the panel. */
  setDraft(listId: string, taskId: string, patch: { done?: boolean; note?: string }) {
    const x = this.task(listId, taskId);
    if (!x || x.t.shared) return;
    if (typeof patch.done === 'boolean') x.t.draft.done = patch.done;
    if (typeof patch.note === 'string') x.t.draft.note = patch.note.slice(0, 8000);
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  addImages(listId: string, taskId: string, imgs: Omit<Img, 'id'>[]) {
    const x = this.task(listId, taskId);
    if (!x || x.t.shared) return;
    for (const i of imgs) {
      if (x.t.draft.images.length >= 8) break;
      if (!/^image\/(png|jpeg|gif|webp)$/.test(i.mime) || typeof i.data !== 'string' || i.data.length > 4_000_000) continue;
      x.t.draft.images.push({ id: randomUUID().slice(0, 8), mime: i.mime, data: i.data, w: i.w | 0, h: i.h | 0 });
    }
    x.t.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  removeImage(listId: string, taskId: string, imageId: string) {
    const x = this.task(listId, taskId);
    if (!x || x.t.shared) return;
    x.t.draft.images = x.t.draft.images.filter((i) => i.id !== imageId);
    x.t.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  share(listId: string, taskId: string) {
    const x = this.task(listId, taskId);
    if (!x || x.t.shared) return;
    const d = x.t.draft;
    x.t.shared = { at: Date.now(), done: d.done, note: d.note.trim(), images: [...d.images] };
    x.t.withdrawn = false;
    x.t.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  unshare(listId: string, taskId: string) {
    const x = this.task(listId, taskId);
    if (!x || !x.t.shared) return;
    if (x.t.seenAt) x.t.withdrawn = true;
    x.t.shared = undefined;
    x.t.seenAt = undefined;
    x.t.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  setHidden(listId: string, hidden: boolean) {
    const c = this.lists.get(listId);
    if (!c || c.hidden === hidden) return;
    c.hidden = hidden;
    this.emit({ checklist: c, kind: 'updated' });
  }

  close(listId: string) {
    const c = this.lists.get(listId);
    if (!c || c.closed) return;
    c.closed = true;
    this.emit({ checklist: c, kind: 'closed' });
  }

  /** Forget closed checklists after a while (they are kept briefly so Claude can be told). */
  prune(maxAgeMs: number) {
    for (const c of [...this.lists.values()]) {
      if (c.closed && Date.now() - c.updatedAt > maxAgeMs) {
        this.lists.delete(c.id);
        this.emit({ checklist: c, kind: 'removed' });
      }
    }
  }

  /* ---------- tools (Claude) ---------- */

  handleTool(sessionId: string, meta: CallMeta, name: string, args: any): ToolResult {
    try {
      switch (name) {
        case 'checklist_add_tasks':
          return this.toolAdd(sessionId, meta, args ?? {});
        case 'checklist_read':
          return this.toolRead(sessionId, args ?? {});
        case 'checklist_edit':
          return this.toolEdit(sessionId, args ?? {});
        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e: any) {
      return err(e?.message ?? String(e));
    }
  }

  private toolAdd(sessionId: string, meta: CallMeta, args: any): ToolResult {
    const raw = Array.isArray(args.tasks) ? args.tasks : [];
    if (!raw.length) return err('`tasks` must be a non-empty array.');
    if (raw.length > MAX_TASKS_PER_CALL) return err(`Add at most ${MAX_TASKS_PER_CALL} tasks per call.`);

    let c = this.forSession(sessionId);
    let created = false;
    if (!c || c.closed) {
      const folder = (meta.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
      c = {
        id: randomUUID(),
        sessionId,
        title: str(args.title, 80) ?? 'Things to do',
        folder,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextId: 1,
        tasks: [],
        groupOrder: [],
        hidden: false,
        closed: false,
      };
      this.lists.set(c.id, c);
      created = true;
    } else if (str(args.title, 80)) {
      c.title = str(args.title, 80)!;
    }

    const ids: string[] = [];
    const now = Date.now();
    raw.forEach((r: any, i: number) => {
      const text = typeof r === 'string' ? str(r, 300) : str(r?.text, 300);
      if (!text) throw new Error(`tasks[${i}].text is required.`);
      const group = str(r?.group, 48);
      if (group && !c!.groupOrder.includes(group)) c!.groupOrder.push(group);
      const t: Task = {
        id: `t${c!.nextId++}`,
        text,
        detail: str(r?.detail),
        command: str(r?.command),
        tags: cleanTags(r?.tags),
        group,
        addedAt: now,
        rev: 1,
        draft: { done: false, note: '', images: [] },
      };
      c!.tasks.push(t);
      ids.push(t.id);
    });

    this.emit({ checklist: c, kind: created ? 'created' : 'tasks-added', added: ids.length });

    const range = ids.length === 1 ? ids[0] : `${ids[0]}–${ids[ids.length - 1]}`;
    const lines = [
      `Added ${ids.length} task${ids.length === 1 ? '' : 's'} (${range}) to the checklist "${c.title}" in VS Code.`,
      'The user will share them one by one when ready; you can keep working meanwhile. Use checklist_read to see what they shared.',
    ];
    const fresh = this.unread(c).length;
    if (fresh) lines.push(`Note: ${fresh} task${fresh === 1 ? ' was' : 's were'} shared since your last read. Call checklist_read.`);
    return ok(lines.join('\n'));
  }

  private unread(c: Checklist) {
    return c.tasks.filter((t) => (t.shared && (!t.seenAt || t.shared.at > t.seenAt)) || t.withdrawn);
  }

  private toolRead(sessionId: string, args: any): ToolResult {
    const c = this.forSession(sessionId);
    if (!c) return ok('This chat has no checklist yet. Add tasks with checklist_add_tasks when the user needs to do something by hand.');

    const now = Date.now();
    const shared = c.tasks.filter((t) => t.shared);
    const waiting = c.tasks.filter((t) => !t.shared);
    const fresh = this.unread(c);
    const earlier = shared.filter((t) => !fresh.includes(t));
    const content: Content[] = [];
    const images: { label: string; img: Img }[] = [];

    const out: string[] = [];
    out.push(
      `Checklist "${c.title}"${c.closed ? ' (CLOSED by the user — it no longer shows in VS Code; adding tasks starts a new checklist)' : ''}: ` +
        `${c.tasks.length} tasks, ${shared.length} shared by the user, ${waiting.length} waiting.`
    );

    const describe = (t: Task, full: boolean) => {
      const s = t.shared!;
      const state = s.done ? 'DONE' : 'NOT DONE';
      const tags = t.tags.length ? ` [${t.tags.join(', ')}]` : '';
      const lines = [`- ${t.id} ${t.text}${tags}: ${state}`];
      if (full) {
        if (s.note) lines.push(`  Note from the user: ${quote(s.note)}`);
        if (s.images.length) lines.push(`  ${s.images.length} screenshot${s.images.length === 1 ? '' : 's'} attached below.`);
      } else if (s.note) {
        lines.push(`  Note: ${quote(s.note.length > 140 ? s.note.slice(0, 140) + '…' : s.note)}`);
      }
      return lines.join('\n');
    };

    if (fresh.length) {
      out.push('', 'New since your last read:');
      for (const t of fresh) {
        if (t.withdrawn && !t.shared) {
          out.push(`- ${t.id} ${t.text}: the user took this back to change it. Treat it as waiting again.`);
          continue;
        }
        out.push(describe(t, true));
        t.shared!.images.forEach((img, i) => images.push({ label: `${t.id} screenshot ${i + 1}/${t.shared!.images.length}`, img }));
      }
    } else {
      out.push('', 'Nothing new since your last read.');
    }

    if (earlier.length) {
      out.push('', 'Shared earlier:');
      for (const t of earlier) {
        out.push(describe(t, !!args.include_earlier_images));
        if (args.include_earlier_images)
          t.shared!.images.forEach((img, i) => images.push({ label: `${t.id} screenshot ${i + 1}/${t.shared!.images.length}`, img }));
      }
    }

    if (waiting.length) {
      out.push('', 'Waiting on the user (not shared yet, so you cannot know their state):');
      for (const g of groupsOf(c, waiting)) {
        if (g.name) out.push(`  ${g.name}:`);
        for (const t of g.tasks) out.push(`${g.name ? '  ' : ''}- ${t.id} ${t.text}${t.tags.length ? ` [${t.tags.join(', ')}]` : ''}`);
      }
    }

    const sent = images.slice(0, MAX_IMAGES_PER_READ);
    if (images.length > sent.length)
      out.push('', `(${images.length - sent.length} more screenshots not included; call again with include_earlier_images if needed.)`);
    content.push({ type: 'text', text: out.join('\n') });
    for (const { label, img } of sent) {
      content.push({ type: 'text', text: label });
      content.push({ type: 'image', data: img.data, mimeType: img.mime });
    }

    // Mark as seen so the panel can show it.
    let changed = false;
    for (const t of fresh) {
      if (t.shared) t.seenAt = now;
      t.withdrawn = false;
      t.rev++;
      changed = true;
    }
    c.lastReadAt = now;
    if (changed) this.emit({ checklist: c, kind: 'updated' });
    return { content };
  }

  private toolEdit(sessionId: string, args: any): ToolResult {
    const c = this.forSession(sessionId);
    if (!c || c.closed) return err('This chat has no open checklist. Use checklist_add_tasks to start one.');
    const notes: string[] = [];
    if (str(args.title, 80)) c.title = str(args.title, 80)!;

    for (const u of Array.isArray(args.updates) ? args.updates : []) {
      const t = c.tasks.find((x) => x.id === u?.id);
      if (!t) {
        notes.push(`${u?.id}: no such task.`);
        continue;
      }
      const wording = ['text', 'detail', 'command'].some((k) => typeof u[k] === 'string');
      if (wording && t.shared) notes.push(`${t.id}: already shared by the user, so its wording was kept.`);
      else {
        if (str(u.text, 300)) t.text = str(u.text, 300)!;
        if (typeof u.detail === 'string') t.detail = str(u.detail);
        if (typeof u.command === 'string') t.command = str(u.command);
      }
      if (Array.isArray(u.tags)) t.tags = cleanTags(u.tags);
      if (Array.isArray(u.add_tags)) t.tags = cleanTags([...t.tags, ...u.add_tags]);
      if (Array.isArray(u.remove_tags)) {
        const rm = cleanTags(u.remove_tags);
        t.tags = t.tags.filter((x) => !rm.includes(x));
      }
      if (typeof u.group === 'string') {
        t.group = str(u.group, 48);
        if (t.group && !c.groupOrder.includes(t.group)) c.groupOrder.push(t.group);
      }
      t.rev++;
    }

    if (Array.isArray(args.remove)) {
      const before = c.tasks.length;
      c.tasks = c.tasks.filter((t) => !args.remove.includes(t.id));
      if (before !== c.tasks.length) notes.push(`Removed ${before - c.tasks.length} task(s).`);
    }
    if (Array.isArray(args.group_order)) {
      const want = args.group_order.map((g: unknown) => str(g, 48)).filter(Boolean) as string[];
      c.groupOrder = [...want, ...c.groupOrder.filter((g) => !want.includes(g))];
    }
    c.groupOrder = c.groupOrder.filter((g) => c.tasks.some((t) => t.group === g));

    this.emit({ checklist: c, kind: 'updated' });
    return ok(['Checklist updated.', ...notes].join('\n'));
  }
}

/** Tasks bucketed by group, in display order (ungrouped first). */
export function groupsOf(c: Checklist, tasks = c.tasks): { name?: string; tasks: Task[] }[] {
  const out: { name?: string; tasks: Task[] }[] = [];
  const loose = tasks.filter((t) => !t.group);
  if (loose.length) out.push({ tasks: loose });
  for (const g of c.groupOrder) {
    const ts = tasks.filter((t) => t.group === g);
    if (ts.length) out.push({ name: g, tasks: ts });
  }
  return out;
}

const quote = (s: string) => JSON.stringify(s);
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
