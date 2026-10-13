// The message envelope — the wire contract every adapter (Claude, Codex, a
// human with a browser) agrees on. See PROTOCOL.md. Nothing else is shared.
//
// On the wire a Discussion comment is:
//
//   <human-readable body>
//
//   <!-- hive:envelope
//   {"from":"nikolaus/claude","type":"summary","refs":["task/3"]}
//   -->
//
// The body is NOT duplicated inside the envelope: the envelope's `body` is
// whatever text surrounds it. A fenced ```hive block is accepted as an
// alternative carrier for clients that can't emit HTML comments.

export const MESSAGE_TYPES = [
  "claim",
  "summary",
  "question",
  "review_request",
  "handoff",
  "decision",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface Lease {
  paths: string[];
  expires: string; // ISO 8601
}

export interface Envelope {
  from: string; // "<person>/<agent>" or bare "<person>" for humans
  type: MessageType;
  refs: string[];
  body: string;
  lease?: Lease;
  confidence?: number;
  // Protocol extension (see PROTOCOL.md): explicit addressees. Used by loop
  // control ("speak only when addressed") and by handoff lease transfer.
  to?: string[];
}

const FROM_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/;
const COMMENT_RE = /<!--\s*hive:envelope\s*([\s\S]*?)-->/;
const FENCE_RE = /```(?:json[ \t]+)?hive[ \t]*\r?\n([\s\S]*?)```/;

export function isAgent(from: string): boolean {
  return from.includes("/");
}

export function personOf(from: string): string {
  return from.split("/")[0];
}

export type ParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: "absent" }
  | { ok: false; reason: "invalid"; error: string; body: string };

/** Extract and validate the envelope carried in a comment body. */
export function parseEnvelope(text: string): ParseResult {
  const m = COMMENT_RE.exec(text) ?? FENCE_RE.exec(text);
  if (!m) return { ok: false, reason: "absent" };
  const body = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, reason: "invalid", error: `bad JSON: ${(e as Error).message}`, body };
  }
  const err = validate(raw);
  if (err) return { ok: false, reason: "invalid", error: err, body };
  const r = raw as Omit<Envelope, "body">;
  return { ok: true, envelope: { ...r, refs: r.refs ?? [], body } };
}

function validate(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "envelope is not an object";
  const o = raw as Record<string, unknown>;
  if (typeof o.from !== "string" || !FROM_RE.test(o.from)) return "from must be <person> or <person>/<agent>";
  if (!MESSAGE_TYPES.includes(o.type as MessageType)) return `type must be one of ${MESSAGE_TYPES.join(", ")}`;
  if (o.refs !== undefined && !isStringArray(o.refs)) return "refs must be an array of strings";
  if (o.to !== undefined && !(isStringArray(o.to) && o.to.every((t) => FROM_RE.test(t)))) return "to must be an array of participant ids";
  if (o.confidence !== undefined && !(typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1))
    return "confidence must be a number in [0, 1]";
  if (o.lease !== undefined) {
    const l = o.lease as Record<string, unknown>;
    if (typeof l !== "object" || l === null) return "lease must be an object";
    if (!isStringArray(l.paths) || l.paths.length === 0) return "lease.paths must be a non-empty array of strings";
    if (l.paths.some((p) => p.startsWith("/") || p.split("/").includes(".."))) return "lease.paths must be repo-relative";
    if (typeof l.expires !== "string" || Number.isNaN(Date.parse(l.expires))) return "lease.expires must be ISO 8601";
  }
  if (o.type === "claim" && o.lease === undefined) return "claim requires a lease";
  return null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Render an envelope as a Discussion comment body. */
export function renderEnvelope(env: Envelope): string {
  const { body, ...meta } = env;
  // `--` cannot appear inside an HTML comment. In serialized JSON it can only
  // occur inside a string, where - decodes back to '-'.
  const json = JSON.stringify(meta).replace(/--/g, "-\\u002d");
  return `${body.trim()}\n\n<!-- hive:envelope\n${json}\n-->`;
}
