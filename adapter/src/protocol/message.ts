// A channel message: one Discussion comment (or reply), decoded.

import { parseEnvelope, personOf, type Envelope } from "./envelope.js";

export interface RawComment {
  id: string;
  author: string | null; // GitHub login; null for deleted accounts
  createdAt: string;
  url: string;
  body: string;
}

export interface Message {
  id: string;
  task: string;
  author: string | null;
  createdAt: string;
  url: string;
  /** Participant id: envelope.from, or the roster person for a bare human comment. */
  from: string;
  body: string;
  envelope: Envelope | null;
  /** The envelope's person maps to the GitHub account that posted it. */
  verified: boolean;
  invalid?: string;
}

/** person -> GitHub login. Committed as participants.json. */
export type Roster = Record<string, { github: string }>;

export function loginToPerson(roster: Roster, login: string): string {
  for (const [person, p] of Object.entries(roster)) if (p.github.toLowerCase() === login.toLowerCase()) return person;
  return login;
}

function personMatchesLogin(roster: Roster, person: string, login: string | null): boolean {
  if (!login) return false;
  const gh = roster[person]?.github ?? person;
  return gh.toLowerCase() === login.toLowerCase();
}

export function decodeComment(c: RawComment, task: string, roster: Roster): Message {
  const parsed = parseEnvelope(c.body);
  const base = { id: c.id, task, author: c.author, createdAt: c.createdAt, url: c.url };
  if (parsed.ok) {
    const env = parsed.envelope;
    return {
      ...base,
      from: env.from,
      body: env.body,
      envelope: env,
      verified: personMatchesLogin(roster, personOf(env.from), c.author),
    };
  }
  // No (valid) envelope: a plain human comment from the web UI or phone.
  return {
    ...base,
    from: c.author ? loginToPerson(roster, c.author) : "ghost",
    body: parsed.reason === "invalid" ? parsed.body : c.body.trim(),
    envelope: null,
    verified: c.author !== null,
    ...(parsed.reason === "invalid" ? { invalid: parsed.error } : {}),
  };
}

export const TASK_TITLE_RE = /^task\/([A-Za-z0-9_.-]+):\s*(.*)$/;

export function taskTitle(id: string, title: string): string {
  return `task/${id}: ${title}`;
}
