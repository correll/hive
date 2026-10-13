// tasks/<id>-<slug>.md — claimable work units, one file each.
//
//   ---
//   id: 3
//   title: Daemon mode via Agent SDK streaming input
//   paths: [adapter/src/daemon/]
//   status: open
//   ---
//   free-form description
//
// The Discussion for a task is found by title ("task/3: ..."), so opening a
// channel never requires a commit to main.

export interface Task {
  id: string;
  title: string;
  paths: string[];
  status: string;
  body: string;
  file: string;
}

/** Minimal frontmatter reader: `key: value` and `key: [a, b]` lines only. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*(#.*)?$/.exec(line);
    if (!kv) continue;
    const v = kv[2];
    data[kv[1]] = v.startsWith("[")
      ? v.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean)
      : unquote(v);
  }
  return { data, body: m[2] };
}

function unquote(s: string): string {
  return s.trim().replace(/^(['"])(.*)\1$/, "$2");
}

export function parseTask(file: string, text: string): Task | null {
  const { data, body } = parseFrontmatter(text);
  const id = typeof data.id === "string" ? data.id : null;
  if (!id) return null;
  const asList = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []);
  return {
    id,
    title: typeof data.title === "string" ? data.title : id,
    paths: asList(data.paths),
    status: typeof data.status === "string" ? data.status : "open",
    body: body.trim(),
    file,
  };
}
