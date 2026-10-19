// Checklist data model and Claude's tools. Pure Node, no `vscode` import, so it can be tested directly.
import { randomUUID } from 'crypto';

/**
 * A screenshot. `data` (base64) is present for new screenshots; screenshots saved to disk are kept
 * without it (`stored`) and their data is loaded only when Claude reads them.
 */
export interface Img { id: string; mime: string; data?: string; stored?: boolean; w: number; h: number }
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
  /** When "Send now" pushed this to Claude (before Claude read it). */
  pushedAt?: number;
}

export interface QOption { id: string; label: string; summary?: string; details?: string }
export interface QDraft { picks: string[]; other: string; note: string; images: Img[] }
export interface Answer { at: number; picks: string[]; other: string; note: string; images: Img[] }

export interface Question {
  id: string;
  question: string;
  why?: string;
  options: QOption[];
  /** Option id Claude recommends, if any, and why. */
  recommended?: string;
  reason?: string;
  multi: boolean;
  allowOther: boolean;
  tags: string[];
  addedAt: number;
  rev: number;
  draft: QDraft;
  answer?: Answer;
  seenAt?: number;
  withdrawn?: boolean;
  pushedAt?: number;
  /** Claude no longer needs an answer. */
  retired?: { at: number; reason?: string };
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
  /** Groups whose tasks must be done in the order Claude added them. */
  orderedGroups: string[];
  /** A roadmap: groups that are stages, to be done one after another in this order. Each is also a sequence inside. */
  phases: string[];
  questions: Question[];
  nextQ: number;
  hidden: boolean;
  closed: boolean;
  lastReadAt?: number;
  /** The user is away until this time (ms). Claude is told not to wait for them. */
  awayUntil?: number;
  /** When the user went away. */
  awayFrom?: number;
}

export interface CallMeta { cwd?: string; client?: string }

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { content: Content[]; isError?: boolean }

export type ChangeKind = 'created' | 'tasks-added' | 'asked' | 'updated' | 'closed' | 'removed';
export interface ChangeEvent { checklist: Checklist; kind: ChangeKind; added?: number; question?: string }

const MAX_IMAGES_PER_READ = 8;
export const MAX_AWAY_MS = 24 * 3600_000;
const MAX_TASKS_PER_CALL = 40;
const MAX_QUESTIONS_PER_CALL = 10;
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
      description: 'Optional labels. "urgent", "important", "optional", "quick" and "blocked" are styled specially; any other short word works too. Tags only rank tasks that can be done in any order: do not use urgent/important on steps inside an ordered group.',
    },
    group: { type: 'string', description: 'Optional section name, e.g. "Database" or "Deploy". Tasks with the same group are shown together.' },
  },
  required: ['text'],
};

const questionSchema = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The decision, as a question ("Which payment gateway should subscriptions use?").' },
    why: { type: 'string', description: 'One or two sentences: what this affects and what is on hold until it is decided.' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short name of the option ("Razorpay").' },
          summary: { type: 'string', description: 'One line: the key difference.' },
          details: { type: 'string', description: 'Optional longer explanation: pros, cons, cost, effort. Shown only if the user expands it.' },
        },
        required: ['label'],
      },
    },
    recommended: { type: 'string', description: 'Optional: the label of the option you recommend.' },
    reason: { type: 'string', description: 'Optional: one line on why you recommend it.' },
    multiple: { type: 'boolean', description: 'Allow picking several options. Default false.' },
    allow_other: { type: 'boolean', description: 'Offer "Something else" with free text. Default true.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Optional, e.g. ["urgent"].' },
  },
  required: ['question', 'options'],
};

export const TOOLS = [
  {
    name: 'checklist_add_tasks',
    title: 'Add tasks to the user\'s checklist',
    description:
      'Adds tasks for THE USER to do by hand (run a command, change a setting, click through a website/dashboard, create a key, ' +
      'test something, give you a value) to this chat\'s checklist in VS Code. The first call opens the checklist; later calls add to it. ' +
      'It does NOT wait: the user works through tasks at their own pace while you keep talking. Do not also list these steps in your reply; ' +
      'just say briefly that you added them. You only learn what happened via checklist_read. ' +
      'If tasks must be done in a fixed order, give them the same group, add them in that order and list the group in ordered_groups: ' +
      'the user then sees them as numbered steps in that order, and tags never reorder them.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short checklist title (only used/changed if given), e.g. "Supabase setup".' },
        tasks: { type: 'array', minItems: 1, maxItems: MAX_TASKS_PER_CALL, items: taskSchema },
        ordered_groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of groups whose tasks must be done in the order you add them (a sequence). Each ordered group is independent of the others: if the groups themselves must be done one after another, use phases instead.',
        },
        phases: {
          type: 'array',
          items: { type: 'string' },
          description: 'For a roadmap whose stages must be done one after another (e.g. "Set up", "Testing", "Wrap up"): the group names of the stages, in the order of the stages. The full list every time. Tasks inside each stage are done in the order you add them.',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'checklist_ask',
    title: 'Ask the user to decide something later',
    description:
      'Puts a decision for the user in the "Decide" section of this chat\'s checklist, with options, details and your recommendation. ' +
      'Use it instead of listing options in your reply whenever the user can decide later and you can keep working meanwhile ' +
      '(a product choice, a trade-off, naming, pricing, which approach to take next). It does NOT wait. Say in one line that you asked. ' +
      'Questions you must have answered before you can do anything at all should be asked normally instead. ' +
      'Answers arrive via checklist_read (or checklist_wait).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short checklist title, only used if this creates the checklist.' },
        questions: { type: 'array', minItems: 1, maxItems: MAX_QUESTIONS_PER_CALL, items: questionSchema },
      },
      required: ['questions'],
    },
  },
  {
    name: 'checklist_read',
    title: 'Read what the user has shared',
    description:
      'Returns the tasks and answers the user has SHARED with you (tasks done or not done, chosen options, notes and screenshots). ' +
      'Unshared tasks and unanswered questions are listed only as waiting: you cannot see drafts. Call this at the start of every reply ' +
      'while this chat\'s checklist has anything waiting, and before you rely on any manual step or decision. Never assume.',
    inputSchema: {
      type: 'object',
      properties: {
        include_earlier_images: { type: 'boolean', description: 'Also re-send images from items you have already read. Default false.' },
      },
    },
  },
  {
    name: 'checklist_wait',
    title: 'Wait for the user\'s next update',
    description:
      'Waits until the user shares a task or answers a question in this chat\'s checklist, then returns the same result as checklist_read. ' +
      'Use it ONLY when you have finished everything you can do and the next step depends on the user, instead of ending your turn; ' +
      'this lets the user\'s answer reach you immediately. Returns after timeout_minutes with no update if the user hasn\'t shared anything. ' +
      'If the user has said they are away, it returns at once and tells you what to do instead of waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_minutes: { type: 'number', description: 'How long to wait, 1 to 25. Default 20.' },
      },
    },
  },
  {
    name: 'checklist_edit',
    title: 'Edit, tag, group or remove tasks and questions',
    description:
      'Changes this chat\'s checklist: rename it; change a task\'s wording, tags or group; reorder groups; remove tasks; ' +
      'update an unanswered question; or withdraw questions that no longer need an answer. ' +
      'Wording of anything the user already shared or answered cannot be changed; tags and group can.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        updates: {
          type: 'array',
          description: 'Task changes.',
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
        question_updates: {
          type: 'array',
          description: 'Changes to questions, e.g. new options or a recommendation. Wording and options only while unanswered.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Question id, e.g. "q2".' },
              question: { type: 'string' },
              why: { type: 'string' },
              options: questionSchema.properties.options,
              recommended: { type: 'string' },
              reason: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              add_tags: { type: 'array', items: { type: 'string' } },
              remove_tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['id'],
          },
        },
        withdraw_questions: { type: 'array', items: { type: 'string' }, description: 'Ids of questions that no longer need an answer.' },
        withdraw_reason: { type: 'string', description: 'Optional one line shown to the user, e.g. "Settled by the new pricing doc".' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks to delete.' },
        group_order: { type: 'array', items: { type: 'string' }, description: 'Group names in the order they should appear.' },
        step_order: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids of ONE group in the order they should now come, e.g. ["t4","t2","t3"]. Use it to reorder the steps of an ordered group. Tasks you leave out, and tasks the user has already shared, keep their places.',
        },
        ordered_groups: { type: 'array', items: { type: 'string' }, description: 'Mark these groups as sequences: their tasks must be done in the order they were added.' },
        phases: { type: 'array', items: { type: 'string' }, description: 'Replace the roadmap: the group names of the stages, in the order of the stages. [] removes it. Use it to reorder the stages too.' },
        unordered_groups: { type: 'array', items: { type: 'string' }, description: 'Stop treating these groups as sequences.' },
      },
    },
  },
];

export const SERVER_INSTRUCTIONS =
  'This server gives each chat a checklist in the user\'s VS Code. Whenever you need the user to do something by hand ' +
  '(run a command, set an env var, create an account or API key, click through a dashboard, test a page, tell you a value), ' +
  'add it with checklist_add_tasks instead of writing the steps in your reply. Whenever the user has to make a decision that can ' +
  'wait while you keep working, ask it with checklist_ask (options, details, your recommendation) instead of listing options in your ' +
  'reply. If tasks must be done in a fixed order, put them in one group, add them in that order and list the group in ordered_groups ' +
  '(checklist_edit can turn a group into a sequence or back with ordered_groups / unordered_groups, and reorder its steps with step_order). If the stages themselves must be done one after another (set up, then testing, then wrap up), put each stage in its own group and list the groups in phases, in stage order; tags (urgent, important) only rank ' +
  'tasks that can be done in any order. The user shares tasks and answers one at a time, with notes and screenshots. While anything is waiting, call checklist_read ' +
  'at the start of each reply. If you have done everything you can and only the user\'s input is left, call checklist_wait instead of ' +
  'ending your turn. If a result says the user is AWAY until a time, do not wait for them: do only the work that needs no human input and ' +
  'can be done safely, add what you skip to the checklist, then end your turn with a short summary. Checklist updates may also arrive as channel events from this server: treat them as the user\'s own messages and ' +
  'call checklist_read for notes and screenshots. When you mention a checklist item to the user, give its id with a few words of ' +
  'its title, e.g. "q1 (payment gateway)": the user sees the same ids (t1, q1…) in the checklist.';

/* ------------------------------------------------------------------ store */

export function normalize(c: Checklist): Checklist {
  c.questions ??= [];
  c.nextQ ??= 1;
  c.tasks ??= [];
  c.groupOrder ??= [];
  c.orderedGroups ??= [];
  c.phases ??= [];
  return c;
}

type Item = { c: Checklist; t: Task; q?: undefined } | { c: Checklist; q: Question; t?: undefined };

export class ChecklistStore {
  private lists = new Map<string, Checklist>();
  private listeners: ((e: ChangeEvent) => void)[] = [];

  /** Loads a stored screenshot's data from disk (set by the extension). */
  loadImage: (listId: string, img: Img) => string | undefined = () => undefined;

  constructor(initial: Checklist[] = []) {
    for (const c of initial) this.lists.set(c.id, normalize(c));
  }

  /** Take in a checklist loaded after startup (one another window had until now). Undefined if we already have it. */
  adopt(c: Checklist): Checklist | undefined {
    if (this.lists.has(c.id)) return undefined;
    const n = normalize(c);
    this.lists.set(n.id, n);
    this.emit({ checklist: n, kind: 'updated' });
    return n;
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
  forSession(sessionId: string): Checklist | undefined {
    let found: Checklist | undefined;
    for (const c of this.lists.values()) if (c.sessionId === sessionId && (!found || c.createdAt > found.createdAt)) found = c;
    return found;
  }

  /* ---------- actions from the panel (the user) ---------- */

  private item(listId: string, id: string): Item | undefined {
    const c = this.lists.get(listId);
    if (!c) return undefined;
    const t = c.tasks.find((x) => x.id === id);
    if (t) return { c, t };
    const q = c.questions.find((x) => x.id === id);
    return q ? { c, q } : undefined;
  }

  /** Draft changes (tick / note) are saved without re-rendering the panel. */
  setDraft(listId: string, taskId: string, patch: { done?: boolean; note?: string }) {
    const x = this.item(listId, taskId);
    if (!x?.t || x.t.shared) return;
    if (typeof patch.done === 'boolean') x.t.draft.done = patch.done;
    if (typeof patch.note === 'string') x.t.draft.note = patch.note.slice(0, 8000);
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  /** Draft answer changes (picks / other text / note). */
  setAnswerDraft(listId: string, qid: string, patch: { picks?: string[]; other?: string; note?: string }) {
    const x = this.item(listId, qid);
    if (!x?.q || x.q.answer || x.q.retired) return;
    const q = x.q;
    if (Array.isArray(patch.picks)) {
      const valid = patch.picks.filter((p) => p === 'other' ? q.allowOther : q.options.some((o) => o.id === p));
      q.draft.picks = q.multi ? [...new Set(valid)] : valid.slice(-1);
    }
    if (typeof patch.other === 'string') q.draft.other = patch.other.slice(0, 4000);
    if (typeof patch.note === 'string') q.draft.note = patch.note.slice(0, 8000);
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  addImages(listId: string, id: string, imgs: Omit<Img, 'id'>[]) {
    const x = this.item(listId, id);
    if (!x || (x.t ? x.t.shared : x.q!.answer)) return;
    const draft = x.t ? x.t.draft : x.q!.draft;
    for (const i of imgs) {
      if (draft.images.length >= 8) break;
      if (!/^image\/(png|jpeg|gif|webp)$/.test(i.mime) || typeof i.data !== 'string' || i.data.length > 4_000_000) continue;
      draft.images.push({ id: randomUUID().slice(0, 8), mime: i.mime, data: i.data, w: i.w | 0, h: i.h | 0 });
    }
    (x.t ?? x.q!).rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  removeImage(listId: string, id: string, imageId: string) {
    const x = this.item(listId, id);
    if (!x || (x.t ? x.t.shared : x.q!.answer)) return;
    const draft = x.t ? x.t.draft : x.q!.draft;
    draft.images = draft.images.filter((i) => i.id !== imageId);
    (x.t ?? x.q!).rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  share(listId: string, taskId: string) {
    const x = this.item(listId, taskId);
    if (!x?.t || x.t.shared) return;
    const d = x.t.draft;
    x.t.shared = { at: Date.now(), done: d.done, note: d.note.trim(), images: [...d.images] };
    x.t.withdrawn = false;
    x.t.pushedAt = undefined;
    x.t.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  unshare(listId: string, taskId: string) {
    const x = this.item(listId, taskId);
    if (!x?.t || !x.t.shared) return;
    if (x.t.seenAt || x.t.pushedAt) x.t.withdrawn = true;
    x.t.shared = undefined;
    x.t.seenAt = undefined;
    x.t.pushedAt = undefined;
    x.t.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  /** Returns false when there is nothing to send yet (no option picked and no "something else" text). */
  shareAnswer(listId: string, qid: string): boolean {
    const x = this.item(listId, qid);
    if (!x?.q || x.q.answer || x.q.retired) return false;
    const d = x.q.draft;
    const picks = d.picks.filter((p) => p !== 'other');
    const other = d.picks.includes('other') || (!picks.length && x.q.allowOther) ? d.other.trim() : '';
    if (!picks.length && !other) return false;
    x.q.answer = { at: Date.now(), picks, other, note: d.note.trim(), images: [...d.images] };
    x.q.withdrawn = false;
    x.q.pushedAt = undefined;
    x.q.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
    return true;
  }

  unshareAnswer(listId: string, qid: string) {
    const x = this.item(listId, qid);
    if (!x?.q || !x.q.answer) return;
    if (x.q.seenAt || x.q.pushedAt) x.q.withdrawn = true;
    x.q.answer = undefined;
    x.q.seenAt = undefined;
    x.q.pushedAt = undefined;
    x.q.rev++;
    this.emit({ checklist: x.c, kind: 'updated' });
  }

  /** Records that "Send now" pushed these items to Claude. */
  markPushed(listId: string, ids: string[]) {
    const c = this.lists.get(listId);
    if (!c) return;
    const now = Date.now();
    for (const id of ids) {
      const x = this.item(listId, id);
      if (!x) continue;
      (x.t ?? x.q!).pushedAt = now;
      (x.t ?? x.q!).rev++;
    }
    this.emit({ checklist: c, kind: 'updated' });
  }

  /** True while the user has said they are away from this checklist's chat. */
  isAway(c: Checklist, now = Date.now()): boolean {
    return !c.closed && !!c.awayUntil && c.awayUntil > now;
  }

  /** The user will be away until `until` (ms). Refuses a time in the past or more than a day ahead. */
  setAway(listId: string, until: number, now = Date.now()): boolean {
    const c = this.lists.get(listId);
    if (!c || c.closed || !Number.isFinite(until) || until <= now || until > now + MAX_AWAY_MS) return false;
    if (!this.isAway(c, now)) c.awayFrom = now;
    c.awayUntil = Math.round(until);
    this.emit({ checklist: c, kind: 'updated' });
    return true;
  }

  /** The user is back. Returns what was set, so the caller can tell Claude. */
  endAway(listId: string): { from: number } | undefined {
    const c = this.lists.get(listId);
    if (!c || !c.awayUntil) return undefined;
    const from = c.awayFrom ?? 0;
    c.awayUntil = c.awayFrom = undefined;
    this.emit({ checklist: c, kind: 'updated' });
    return { from };
  }

  /** Ends every away that has run out. Returns those checklists with when each away began. */
  expireAway(now = Date.now()): { c: Checklist; from: number }[] {
    const out: { c: Checklist; from: number }[] = [];
    for (const c of [...this.lists.values()])
      if (c.awayUntil && c.awayUntil <= now) {
        const r = this.endAway(c.id);
        if (r) out.push({ c, from: r.from });
      }
    return out;
  }

  /** What to tell Claude while the user is away (undefined when they are not). */
  awayNote(c: Checklist | undefined): string | undefined {
    if (!c || !this.isAway(c)) return undefined;
    const until = new Date(c.awayUntil!);
    const mins = Math.max(1, Math.round((c.awayUntil! - Date.now()) / 60_000));
    const left = mins < 90 ? `${mins} minute${mins === 1 ? '' : 's'}` : `about ${Math.round(mins / 60)} hours`;
    const clock = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = until.toDateString() === new Date().toDateString() ? '' : ' tomorrow';
    return (
      `THE USER IS AWAY until ${clock}${day} (in ${left}), and may come back sooner. Do NOT wait for them and do not call checklist_wait. ` +
      'Do every remaining piece of work that needs no human input and that you can finish safely and correctly. ' +
      'Do not guess answers to waiting questions, do not do anything that depends on an unfinished manual task or an unanswered question, ' +
      'and do not do anything risky or hard to undo (deploys, deleting data, spending money, messaging other people). ' +
      'Add what you skipped to the checklist, then end your turn with a short summary of what you did and what is waiting for the user.'
    );
  }

  /** Same as awayNote, found by chat. */
  awayNoteFor(sessionId: string): string | undefined {
    return this.awayNote(this.forSession(sessionId));
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

  /* ---------- what Claude hasn't seen yet ---------- */

  unread(c: Checklist): { tasks: Task[]; questions: Question[] } {
    return {
      tasks: c.tasks.filter((t) => (t.shared && (!t.seenAt || t.shared.at > t.seenAt)) || t.withdrawn),
      questions: c.questions.filter((q) => !q.retired && ((q.answer && (!q.seenAt || q.answer.at > q.seenAt)) || q.withdrawn)),
    };
  }

  hasUnread(sessionId: string): boolean {
    const c = this.forSession(sessionId);
    if (!c) return false;
    const u = this.unread(c);
    return u.tasks.length + u.questions.length > 0 || !!c.closed;
  }

  /** Anything still waiting on the user (so waiting makes sense). */
  hasPending(sessionId: string): boolean {
    const c = this.forSession(sessionId);
    return !!c && !c.closed && (c.tasks.some((t) => !t.shared) || c.questions.some((q) => !q.answer && !q.retired));
  }

  /** Plain-language summary of everything shared but not yet read, for "Send now". */
  updateSummary(c: Checklist, style: 'line' | 'full'): { text: string; ids: string[] } {
    // Skip what "Send now" already handed over, so pressing it twice doesn't send it twice.
    const all = this.unread(c);
    const u = { tasks: all.tasks.filter((t) => !t.pushedAt), questions: all.questions.filter((q) => !q.pushedAt) };
    const parts: string[] = [];
    const ids: string[] = [];
    for (const q of u.questions) {
      ids.push(q.id);
      if (!q.answer) {
        parts.push(`I took back my answer to ${q.id} ("${q.question}") to change it`);
        continue;
      }
      const choice = answerText(q, q.answer);
      if (style === 'line') parts.push(`I answered ${q.id} ("${clip(q.question, 80)}"): ${clip(choice, 120)}`);
      else {
        let s = `- ${q.id} ${q.question}\n  Answer: ${choice}`;
        if (q.answer.note) s += `\n  Note: ${quote(q.answer.note)}`;
        if (q.answer.images.length) s += `\n  ${q.answer.images.length} screenshot(s): call checklist_read to see them.`;
        parts.push(s);
      }
    }
    for (const t of u.tasks) {
      ids.push(t.id);
      if (!t.shared) {
        parts.push(`I took back ${t.id} ("${t.text}") to change it`);
        continue;
      }
      const state = t.shared.done ? 'done' : 'NOT done';
      if (style === 'line') parts.push(`${t.id} ("${clip(t.text, 60)}") is ${state}${t.shared.note ? `: ${clip(t.shared.note, 100)}` : ''}`);
      else {
        let s = `- ${t.id} ${t.text}: ${state.toUpperCase()}`;
        if (t.shared.note) s += `\n  Note: ${quote(t.shared.note)}`;
        if (t.shared.images.length) s += `\n  ${t.shared.images.length} screenshot(s): call checklist_read to see them.`;
        parts.push(s);
      }
    }
    if (!parts.length) return { text: '', ids };
    if (style === 'line')
      return { text: clip(`Checklist update: ${parts.join('; ')}. Read the checklist for my notes.`, 700).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' '), ids };
    return { text: `The user shared these from the checklist "${c.title}":\n${parts.join('\n')}`, ids };
  }

  /* ---------- tools (Claude) ---------- */

  handleTool(sessionId: string, meta: CallMeta, name: string, args: any): ToolResult {
    try {
      switch (name) {
        case 'checklist_add_tasks':
          return this.toolAdd(sessionId, meta, args ?? {});
        case 'checklist_ask':
          return this.toolAsk(sessionId, meta, args ?? {});
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

  private ensureList(sessionId: string, meta: CallMeta, title: unknown): { c: Checklist; created: boolean } {
    let c = this.forSession(sessionId);
    if (c && !c.closed) {
      if (str(title, 80)) c.title = str(title, 80)!;
      return { c, created: false };
    }
    const folder = (meta.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
    c = {
      id: randomUUID(),
      sessionId,
      title: str(title, 80) ?? 'Things to do',
      folder,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextId: 1,
      tasks: [],
      groupOrder: [],
      orderedGroups: [],
      phases: [],
      questions: [],
      nextQ: 1,
      hidden: false,
      closed: false,
    };
    this.lists.set(c.id, c);
    return { c, created: true };
  }

  private freshNote(c: Checklist): string | undefined {
    const u = this.unread(c);
    const n = u.tasks.length + u.questions.length;
    return n ? `Note: ${n} item${n === 1 ? ' was' : 's were'} shared since your last read. Call checklist_read.` : undefined;
  }

  /** Sets the roadmap. A name only counts if a task is in that group, so no empty stage is left behind. [] removes the roadmap. */
  private markPhases(c: Checklist, names: unknown, notes: string[]) {
    if (!Array.isArray(names)) return;
    const good: string[] = [];
    for (const g of [...new Set(names.map((x) => str(x, 48)).filter((x): x is string => !!x))]) {
      if (c.tasks.some((t) => t.group === g)) good.push(g);
      else notes.push(`${g}: no task is in a group with exactly this name, so it is not a phase.`);
    }
    c.phases = good;
  }

  /** Several ordered groups are independent. If Claude names more than one without phases, say what phases are for. */
  private noteSeveralOrdered(c: Checklist, args: any, notes: string[]) {
    const named = Array.isArray(args.ordered_groups) ? args.ordered_groups.map((g: unknown) => str(g, 48)).filter((g: string | undefined) => g && !c.phases.includes(g)) : [];
    if (named.length >= 2 && !Array.isArray(args.phases))
      notes.push('Note: ordered groups are independent of each other, so the user sees a "next" step in each. If these groups are stages that must be done one after another, call checklist_edit with phases listing the groups in stage order.');
  }

  /** Marks groups as sequences. A group only counts if one of its tasks exists, so no empty group is left behind. */
  private markOrdered(c: Checklist, names: unknown, notes: string[]) {
    for (const g of Array.isArray(names) ? names : []) {
      const name = str(g, 48);
      if (!name) continue;
      if (!c.tasks.some((t) => t.group === name)) notes.push(`${name}: no task is in a group with exactly this name, so it was not marked as ordered.`);
      else if (!c.orderedGroups.includes(name)) c.orderedGroups.push(name);
    }
  }

  /** Puts the listed tasks of one group in the given order. They keep the places they already hold in the list; tasks not listed are not moved. */
  private reorderSteps(c: Checklist, order: unknown, notes: string[]) {
    if (!Array.isArray(order)) return;
    const found: Task[] = [];
    for (const id of [...new Set(order.map((x) => String(x)))]) {
      const t = c.tasks.find((x) => x.id === id);
      if (!t) notes.push(`step_order: ${id} is not a task.`);
      else if (t.shared) notes.push(`step_order: ${id} is already shared by the user, so it stays where it is.`);
      else found.push(t);
    }
    if (found.length < 2) return void notes.push('step_order: list at least two tasks of the same group that the user has not shared yet.');
    const group = found[0].group;
    if (!group || found.some((t) => t.group !== group)) return void notes.push('step_order: all the tasks must be in the same group, so the order was not changed.');
    const slots = c.tasks.map((t, i) => (found.includes(t) ? i : -1)).filter((i) => i >= 0);
    slots.forEach((slot, k) => (c.tasks[slot] = found[k]));
    const whole = c.tasks.filter((t) => t.group === group);
    notes.push(`"${group}" is now in this order: ${whole.map((t) => t.id).join(', ')}.` + (whole.length > found.length ? ' Tasks you left out, and tasks the user has already shared, kept their places.' : ''));
    if (!isSequence(c, group)) notes.push(`"${group}" is not an ordered group, so the order only matters once you list it in ordered_groups.`);
  }

  private toolAdd(sessionId: string, meta: CallMeta, args: any): ToolResult {
    const raw = Array.isArray(args.tasks) ? args.tasks : [];
    if (!raw.length) return err('`tasks` must be a non-empty array.');
    if (raw.length > MAX_TASKS_PER_CALL) return err(`Add at most ${MAX_TASKS_PER_CALL} tasks per call.`);
    raw.forEach((r: any, i: number) => {
      if (!(typeof r === 'string' ? str(r, 300) : str(r?.text, 300))) throw new Error(`tasks[${i}].text is required.`);
    });

    const { c, created } = this.ensureList(sessionId, meta, args.title);
    const ids: string[] = [];
    const now = Date.now();
    for (const r of raw) {
      const text = (typeof r === 'string' ? str(r, 300) : str(r?.text, 300))!;
      const group = str(r?.group, 48);
      if (group && !c.groupOrder.includes(group)) c.groupOrder.push(group);
      const t: Task = {
        id: `t${c.nextId++}`,
        text,
        detail: str(r?.detail),
        command: str(r?.command),
        tags: cleanTags(r?.tags),
        group,
        addedAt: now,
        rev: 1,
        draft: { done: false, note: '', images: [] },
      };
      c.tasks.push(t);
      ids.push(t.id);
    }

    const notes: string[] = [];
    this.markOrdered(c, args.ordered_groups, notes);
    this.markPhases(c, args.phases, notes);
    this.noteSeveralOrdered(c, args, notes);

    this.emit({ checklist: c, kind: created ? 'created' : 'tasks-added', added: ids.length });

    const range = ids.length === 1 ? ids[0] : `${ids[0]}–${ids[ids.length - 1]}`;
    const lines = [
      `Added ${ids.length} task${ids.length === 1 ? '' : 's'} (${range}) to the checklist "${c.title}" in VS Code.`,
      'The user will share them one by one when ready; you can keep working meanwhile. Use checklist_read to see what they shared.',
      ...notes,
    ];
    const fresh = this.freshNote(c);
    if (fresh) lines.push(fresh);
    const away = this.awayNote(c);
    if (away) lines.push(away);
    return ok(lines.join('\n'));
  }

  private parseOptions(raw: unknown, where: string): QOption[] {
    if (!Array.isArray(raw) || raw.length < 2) throw new Error(`${where}: give at least 2 options.`);
    if (raw.length > 8) throw new Error(`${where}: give at most 8 options.`);
    return raw.map((o: any, i: number) => {
      const label = typeof o === 'string' ? str(o, 80) : str(o?.label, 80);
      if (!label) throw new Error(`${where}.options[${i}].label is required.`);
      return { id: `o${i + 1}`, label, summary: str(o?.summary, 200), details: str(o?.details, 3000) };
    });
  }

  private pickRecommended(options: QOption[], rec: unknown): string | undefined {
    const r = str(rec, 80)?.toLowerCase();
    return r ? options.find((o) => o.label.toLowerCase() === r)?.id : undefined;
  }

  private toolAsk(sessionId: string, meta: CallMeta, args: any): ToolResult {
    const raw = Array.isArray(args.questions) ? args.questions : [];
    if (!raw.length) return err('`questions` must be a non-empty array.');
    if (raw.length > MAX_QUESTIONS_PER_CALL) return err(`Ask at most ${MAX_QUESTIONS_PER_CALL} questions per call.`);
    // Validate everything before creating anything.
    const parsed = raw.map((r: any, i: number) => {
      const question = str(r?.question, 300);
      if (!question) throw new Error(`questions[${i}].question is required.`);
      const options = this.parseOptions(r?.options, `questions[${i}]`);
      return { r, question, options };
    });

    const { c, created } = this.ensureList(sessionId, meta, args.title);
    const now = Date.now();
    const ids: string[] = [];
    const notes: string[] = [];
    for (const { r, question, options } of parsed) {
      const recommended = this.pickRecommended(options, r.recommended);
      if (r.recommended && !recommended) notes.push(`"${r.recommended}" doesn't match an option label, so no option is marked as recommended.`);
      const q: Question = {
        id: `q${c.nextQ++}`,
        question,
        why: str(r.why, 600),
        options,
        recommended,
        reason: recommended ? str(r.reason, 300) : undefined,
        multi: r.multiple === true,
        allowOther: r.allow_other !== false,
        tags: cleanTags(r.tags),
        addedAt: now,
        rev: 1,
        draft: { picks: [], other: '', note: '', images: [] },
      };
      c.questions.push(q);
      ids.push(q.id);
    }

    this.emit({ checklist: c, kind: created ? 'created' : 'asked', added: ids.length, question: parsed[0].question });
    const lines = [
      `Asked ${ids.length} question${ids.length === 1 ? '' : 's'} (${ids.join(', ')}) in the "Decide" section of "${c.title}" in VS Code.`,
      'Keep working on anything that doesn\'t depend on the answer. Answers arrive via checklist_read; if only the answer is left, call checklist_wait.',
      ...notes,
    ];
    const fresh = this.freshNote(c);
    if (fresh) lines.push(fresh);
    const away = this.awayNote(c);
    if (away) lines.push(away);
    return ok(lines.join('\n'));
  }

  private toolRead(sessionId: string, args: any): ToolResult {
    const c = this.forSession(sessionId);
    if (!c) return ok('This chat has no checklist yet. Add tasks with checklist_add_tasks, or ask a decision with checklist_ask.');

    const now = Date.now();
    const shared = c.tasks.filter((t) => t.shared);
    const waiting = c.tasks.filter((t) => !t.shared);
    const liveQs = c.questions.filter((q) => !q.retired);
    const answered = liveQs.filter((q) => q.answer);
    const openQs = liveQs.filter((q) => !q.answer);
    const fresh = this.unread(c);
    const earlier = shared.filter((t) => !fresh.tasks.includes(t));
    const earlierQs = answered.filter((q) => !fresh.questions.includes(q));
    const content: Content[] = [];
    const images: { label: string; img: Img }[] = [];

    const out: string[] = [];
    const counts = [`${c.tasks.length} tasks, ${shared.length} shared by the user, ${waiting.length} waiting`];
    if (liveQs.length) counts.push(`${liveQs.length} questions, ${answered.length} answered, ${openQs.length} waiting`);
    out.push(
      `Checklist "${c.title}"${c.closed ? ' (CLOSED by the user — it no longer shows in VS Code; adding tasks starts a new checklist)' : ''}: ` +
        counts.join('; ') + '.'
    );
    const away = this.awayNote(c);
    if (away) out.push('', away);

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
    const describeQ = (q: Question, full: boolean) => {
      const a = q.answer!;
      const lines = [`- ${q.id} ${q.question}`, `  ANSWER: ${answerText(q, a)}`];
      if (a.note) lines.push(full ? `  Note from the user: ${quote(a.note)}` : `  Note: ${quote(clip(a.note, 140))}`);
      if (full && a.images.length) lines.push(`  ${a.images.length} screenshot${a.images.length === 1 ? '' : 's'} attached below.`);
      return lines.join('\n');
    };

    if (fresh.tasks.length || fresh.questions.length) {
      out.push('', 'New since your last read:');
      for (const q of fresh.questions) {
        if (q.withdrawn && !q.answer) {
          out.push(`- ${q.id} ${q.question}: the user took back their answer to change it. Treat it as unanswered again.`);
          continue;
        }
        out.push(describeQ(q, true));
        q.answer!.images.forEach((img, i) => images.push({ label: `${q.id} screenshot ${i + 1}/${q.answer!.images.length}`, img }));
      }
      for (const t of fresh.tasks) {
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

    if (earlierQs.length) {
      out.push('', 'Decided earlier:');
      for (const q of earlierQs) {
        out.push(describeQ(q, !!args.include_earlier_images));
        if (args.include_earlier_images)
          q.answer!.images.forEach((img, i) => images.push({ label: `${q.id} screenshot ${i + 1}/${q.answer!.images.length}`, img }));
      }
    }
    if (earlier.length) {
      out.push('', 'Shared earlier:');
      for (const t of earlier) {
        out.push(describe(t, !!args.include_earlier_images));
        if (args.include_earlier_images)
          t.shared!.images.forEach((img, i) => images.push({ label: `${t.id} screenshot ${i + 1}/${t.shared!.images.length}`, img }));
      }
    }

    if (openQs.length) {
      out.push('', 'Questions waiting for the user\'s decision:');
      for (const q of openQs)
        out.push(`- ${q.id} ${q.question} (options: ${q.options.map((o) => o.label).join(' / ')}${q.allowOther ? ' / something else' : ''})${q.tags.length ? ` [${q.tags.join(', ')}]` : ''}`);
    }
    if (waiting.length) {
      out.push('', 'Tasks waiting on the user (not shared yet, so you cannot know their state):');
      for (const g of groupsOf(c, waiting)) {
        if (g.name) {
          const how = g.phase ? ` (phase ${g.phase} of ${g.phases}: finish the earlier phases first, and do these in this order)` : g.ordered ? ' (to be done in this order)' : '';
          out.push(`  ${g.name}${how}:`);
        }
        const whole = g.ordered ? sequenceOf(c, g.name!) : [];
        for (const t of g.tasks) {
          const step = g.ordered ? ` (step ${whole.indexOf(t) + 1} of ${whole.length})` : '';
          out.push(`${g.name ? '  ' : ''}- ${t.id}${step} ${t.text}${t.tags.length ? ` [${t.tags.join(', ')}]` : ''}`);
        }
      }
    }

    const sent = images.slice(0, MAX_IMAGES_PER_READ);
    if (images.length > sent.length)
      out.push('', `(${images.length - sent.length} more screenshots not included; call again with include_earlier_images if needed.)`);
    content.push({ type: 'text', text: out.join('\n') });
    for (const { label, img } of sent) {
      const data = img.data ?? this.loadImage(c.id, img);
      content.push({ type: 'text', text: label });
      if (data) content.push({ type: 'image', data, mimeType: img.mime });
      else content.push({ type: 'text', text: '(this screenshot could not be loaded)' });
    }

    // Mark as seen so the panel can show it.
    let changed = false;
    for (const it of [...fresh.tasks, ...fresh.questions]) {
      if ('shared' in it ? it.shared : (it as Question).answer) it.seenAt = now;
      it.withdrawn = false;
      it.rev++;
      changed = true;
    }
    c.lastReadAt = now;
    if (changed) this.emit({ checklist: c, kind: 'updated' });
    return { content };
  }

  private toolEdit(sessionId: string, args: any): ToolResult {
    const c = this.forSession(sessionId);
    if (!c || c.closed) return err('This chat has no open checklist. Use checklist_add_tasks or checklist_ask to start one.');
    const notes: string[] = [];
    if (str(args.title, 80)) c.title = str(args.title, 80)!;

    const applyTags = (it: { tags: string[] }, u: any) => {
      if (Array.isArray(u.tags)) it.tags = cleanTags(u.tags);
      if (Array.isArray(u.add_tags)) it.tags = cleanTags([...it.tags, ...u.add_tags]);
      if (Array.isArray(u.remove_tags)) {
        const rm = cleanTags(u.remove_tags);
        it.tags = it.tags.filter((x) => !rm.includes(x));
      }
    };

    const moved: Task[] = []; // tasks given a different group in this call
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
      applyTags(t, u);
      if (typeof u.group === 'string') {
        const was = t.group;
        t.group = str(u.group, 48);
        if (t.group && !c.groupOrder.includes(t.group)) c.groupOrder.push(t.group);
        if (t.group && t.group !== was) moved.push(t);
      }
      t.rev++;
    }

    for (const u of Array.isArray(args.question_updates) ? args.question_updates : []) {
      const q = c.questions.find((x) => x.id === u?.id);
      if (!q || q.retired) {
        notes.push(`${u?.id}: no such open question.`);
        continue;
      }
      const wording = ['question', 'why', 'options', 'recommended', 'reason'].some((k) => u[k] !== undefined);
      if (wording && q.answer) notes.push(`${q.id}: already answered, so its wording and options were kept.`);
      else if (wording) {
        if (str(u.question, 300)) q.question = str(u.question, 300)!;
        if (typeof u.why === 'string') q.why = str(u.why, 600);
        if (u.options !== undefined) {
          q.options = this.parseOptions(u.options, q.id);
          q.draft.picks = q.draft.picks.filter((p) => p === 'other');
          q.recommended = undefined;
        }
        if (typeof u.recommended === 'string') q.recommended = this.pickRecommended(q.options, u.recommended);
        if (typeof u.reason === 'string') q.reason = str(u.reason, 300);
      }
      applyTags(q, u);
      q.rev++;
    }

    if (Array.isArray(args.withdraw_questions)) {
      for (const id of args.withdraw_questions) {
        const q = c.questions.find((x) => x.id === id);
        if (!q || q.retired) continue;
        q.retired = { at: Date.now(), reason: str(args.withdraw_reason, 200) };
        q.rev++;
        notes.push(`Withdrew ${q.id}.`);
      }
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
    if (Array.isArray(args.unordered_groups)) {
      const off = args.unordered_groups.map((g: unknown) => str(g, 48));
      c.orderedGroups = c.orderedGroups.filter((g) => !off.includes(g));
      for (const g of off) if (g && c.phases.includes(g) && !(Array.isArray(args.phases) && !args.phases.map((x: unknown) => str(x, 48)).includes(g)))
        notes.push(`${g} is a phase, so it stays a sequence. Take it out of phases first.`);
      for (const g of Array.isArray(args.ordered_groups) ? args.ordered_groups : []) {
        const name = str(g, 48);
        if (name && off.includes(name)) notes.push(`${name} was in both ordered_groups and unordered_groups, so it is ordered.`);
      }
    }
    this.markOrdered(c, args.ordered_groups, notes);
    this.markPhases(c, args.phases, notes);
    this.noteSeveralOrdered(c, args, notes);
    const orderedBefore = [...c.orderedGroups];
    const phasesBefore = [...c.phases];
    c.groupOrder = c.groupOrder.filter((g) => c.tasks.some((t) => t.group === g));
    c.orderedGroups = c.orderedGroups.filter((g) => c.groupOrder.includes(g));
    c.phases = c.phases.filter((g) => c.groupOrder.includes(g));
    for (const g of phasesBefore.filter((x) => !c.phases.includes(x)))
      notes.push(`${g} has no tasks left, so it is no longer a phase.`);
    for (const g of orderedBefore.filter((x) => !c.orderedGroups.includes(x)))
      notes.push(`${g} has no tasks left, so it is no longer an ordered group. If its tasks moved to another group, list that group in ordered_groups.`);
    // A task moved into an ordered group becomes its last step. step_order changes the order afterwards.
    const arrived = [...new Set(moved)].filter((t) => t.group && isSequence(c, t.group));
    for (const t of arrived) {
      const others = c.tasks.filter((x) => x !== t);
      let at = -1;
      others.forEach((x, i) => { if (x.group === t.group) at = i; });
      others.splice(at < 0 ? others.length : at + 1, 0, t);
      c.tasks = others;
    }
    this.reorderSteps(c, args.step_order, notes);
    for (const t of arrived) {
      const seq = sequenceOf(c, t.group!);
      notes.push(`${t.id} is now step ${seq.indexOf(t) + 1} of ${seq.length} in "${t.group}".` + (Array.isArray(args.step_order) ? '' : ' Use step_order to change the order.'));
    }

    this.emit({ checklist: c, kind: 'updated' });
    return ok(['Checklist updated.', ...notes].join('\n'));
  }
}

export function answerText(q: Question, a: Answer): string {
  const labels = a.picks.map((p) => q.options.find((o) => o.id === p)?.label ?? p);
  if (a.other) labels.push(`Something else: ${quote(a.other)}`);
  return labels.join(' + ') || '(no choice)';
}

/** True if the group's tasks must be done in order: an ordered group, or a phase of the roadmap. */
export function isSequence(c: Checklist, group: string): boolean {
  return c.orderedGroups.includes(group) || c.phases.includes(group);
}

/** The tasks of the sequence a group belongs to, in the order they are done: the whole roadmap for a phase, else the group. */
export function sequenceOf(c: Checklist, group: string): Task[] {
  if (c.phases.includes(group)) return c.phases.flatMap((g) => c.tasks.filter((t) => t.group === g));
  return c.tasks.filter((t) => t.group === group);
}

/** Tasks bucketed by group, in display order (ungrouped first). The phases of the roadmap come together, in phase order, where the first one would be. */
export function groupsOf(c: Checklist, tasks = c.tasks): { name?: string; ordered?: boolean; phase?: number; phases?: number; tasks: Task[] }[] {
  const out: { name?: string; ordered?: boolean; phase?: number; phases?: number; tasks: Task[] }[] = [];
  const loose = tasks.filter((t) => !t.group);
  if (loose.length) out.push({ tasks: loose });
  const names: string[] = [];
  for (const g of c.groupOrder) {
    if (!c.phases.includes(g)) names.push(g);
    else if (!names.some((n) => c.phases.includes(n))) names.push(...c.phases);
  }
  for (const g of c.phases) if (!names.includes(g)) names.push(g); // a phase never goes missing, whatever groupOrder says
  for (const g of names) {
    const ts = tasks.filter((t) => t.group === g);
    if (!ts.length) continue;
    const at = c.phases.indexOf(g);
    out.push({ name: g, ordered: isSequence(c, g), ...(at >= 0 ? { phase: at + 1, phases: c.phases.length } : {}), tasks: ts });
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const quote = (s: string) => JSON.stringify(s);
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
