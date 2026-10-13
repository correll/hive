import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentHopsSinceHuman,
  computeLeases,
  covers,
  decide,
  decodeComment,
  isAddressedTo,
  parseEnvelope,
  parseRepoConfig,
  parseTask,
  renderEnvelope,
  type Envelope,
  type Message,
  type Roster,
} from "../protocol/index.js";

const roster: Roster = { nikolaus: { github: "correll" }, alice: { github: "alice-gh" } };
const policy = { maxMinutes: 240 };
const loop = { maxAgentHops: 3, maxTurnsPerTaskPerAgent: 10, maxUsdPerTaskPerAgent: 5 };

let seq = 0;
function msg(author: string, at: string, env: Omit<Envelope, "body" | "refs"> & { refs?: string[]; body?: string } | string, task = "3"): Message {
  const body = typeof env === "string" ? env : renderEnvelope({ refs: [], body: "", ...env } as Envelope);
  return decodeComment({ id: `C${String(++seq).padStart(4, "0")}`, author, createdAt: at, url: `u${seq}`, body }, task, roster);
}
const iso = (min: number) => new Date(Date.UTC(2026, 9, 13, 12, min)).toISOString();

test("envelope round-trips and keeps the body out of the JSON", () => {
  const env: Envelope = { from: "nikolaus/claude", type: "summary", refs: ["task/3", "PR#17"], body: "Done -- see PR.\n\nArrow --> here", confidence: 0.7 };
  const wire = renderEnvelope(env);
  assert.equal((wire.match(/-->/g) ?? []).length, 2, "only the body's arrow and the closing marker");
  const parsed = parseEnvelope(wire);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.envelope, env);
});

test("fenced hive block is accepted", () => {
  const r = parseEnvelope('Hi\n```hive\n{"from":"alice","type":"question","refs":[]}\n```');
  assert.ok(r.ok && r.envelope.from === "alice" && r.envelope.body === "Hi");
});

test("invalid envelopes are reported, not trusted", () => {
  const r = parseEnvelope('x <!-- hive:envelope {"from":"a/b","type":"claim","refs":[]} -->');
  assert.ok(!r.ok && r.reason === "invalid" && /lease/.test(r.error));
  const abs = parseEnvelope('<!-- hive:envelope {"from":"a/b","type":"claim","lease":{"paths":["../x"],"expires":"2026-01-01T00:00:00Z"}} -->');
  assert.ok(!abs.ok && abs.reason === "invalid");
});

test("plain comments become human messages; spoofed from is unverified", () => {
  assert.equal(msg("correll", iso(0), "just a comment").from, "nikolaus");
  const spoof = msg("alice-gh", iso(0), { from: "nikolaus/claude", type: "summary" });
  assert.equal(spoof.verified, false);
});

test("first claim wins; overlapping later claim is rejected", () => {
  const a = msg("correll", iso(0), { from: "nikolaus/claude", type: "claim", lease: { paths: ["sections/"], expires: iso(60) } });
  const b = msg("alice-gh", iso(1), { from: "alice/codex", type: "claim", lease: { paths: ["sections/intro.tex"], expires: iso(60) } });
  const t = computeLeases([b, a], policy, new Date(iso(5)));
  assert.deepEqual(t.leases.map((l) => l.holder), ["nikolaus/claude"]);
  assert.equal(t.rejections.length, 1);
  assert.equal(t.rejections[0].message.from, "alice/codex");
});

test("leases expire, are capped, and spoofed claims don't count", () => {
  const a = msg("correll", iso(0), { from: "nikolaus/claude", type: "claim", lease: { paths: ["a.tex"], expires: iso(10) } });
  assert.equal(computeLeases([a], policy, new Date(iso(11))).leases.length, 0);
  const long = msg("correll", iso(0), { from: "nikolaus/claude", type: "claim", lease: { paths: ["b.tex"], expires: "2030-01-01T00:00:00Z" } });
  assert.equal(computeLeases([long], policy, new Date(iso(1))).leases[0].expires, new Date(Date.parse(iso(0)) + 240 * 60_000).toISOString());
  const spoof = msg("alice-gh", iso(0), { from: "nikolaus/claude", type: "claim", lease: { paths: ["c.tex"], expires: iso(30) } });
  assert.equal(computeLeases([spoof], policy, new Date(iso(1))).leases.length, 0);
});

test("handoff releases, or transfers to a single addressee", () => {
  const claim = msg("correll", iso(0), { from: "nikolaus/claude", type: "claim", lease: { paths: ["x.tex"], expires: iso(60) } });
  const release = msg("correll", iso(5), { from: "nikolaus/claude", type: "handoff" });
  assert.equal(computeLeases([claim, release], policy, new Date(iso(6))).leases.length, 0);
  const transfer = msg("correll", iso(5), { from: "nikolaus/claude", type: "handoff", to: ["alice/codex"], lease: { paths: ["x.tex", "not-mine.tex"], expires: iso(60) } });
  const t = computeLeases([claim, transfer], policy, new Date(iso(6)));
  assert.deepEqual(t.leases.map((l) => [l.holder, l.path]), [["alice/codex", "x.tex"]]);
});

test("path coverage", () => {
  assert.ok(covers("sections/", "sections/a.tex"));
  assert.ok(covers("./a.tex", "a.tex"));
  assert.ok(!covers("sections", "sections/a.tex"));
  assert.ok(!covers("sec/", "sections/a.tex"));
});

test("addressing and hop counting", () => {
  const h = msg("correll", iso(0), "hey @alice/codex can you check this?");
  assert.ok(isAddressedTo(h, "alice/codex"));
  assert.ok(!isAddressedTo(h, "alice/codex2"));
  assert.ok(!isAddressedTo(msg("correll", iso(0), "email alice@alice/codex.org"), "alice/codex"));
  const a1 = msg("correll", iso(1), { from: "nikolaus/claude", type: "summary", to: ["alice/codex"] });
  const a2 = msg("alice-gh", iso(2), { from: "alice/codex", type: "summary", to: ["nikolaus/claude"] });
  const a3 = msg("correll", iso(3), { from: "nikolaus/claude", type: "question", to: ["alice/codex"] });
  const thread = [h, a1, a2, a3];
  assert.equal(agentHopsSinceHuman(thread, a3), 3);
  const empty = { leases: [], rejections: [] };
  const v = decide(a3, thread, "alice/codex", empty, { turns: 0, usd: 0 }, loop);
  assert.ok(!v.respond && /human gate/.test(v.reason));
  assert.ok(decide(a1, thread, "alice/codex", empty, { turns: 0, usd: 0 }, loop).respond);
  assert.ok(!decide(a1, thread, "alice/codex", empty, { turns: 0, usd: 5 }, loop).respond);
  assert.ok(!decide(h, thread, "bob/claude", empty, { turns: 0, usd: 0 }, loop).respond);
});

test("hive.json requires explicit loop limits", () => {
  assert.throws(() => parseRepoConfig(JSON.stringify({ repo: "a/b", discussionCategory: "General", lease: { defaultMinutes: 60, maxMinutes: 240 } })), /loop is required/);
  const c = parseRepoConfig(JSON.stringify({ repo: "a/b", discussionCategory: "General", lease: { defaultMinutes: 60, maxMinutes: 240 }, loop }));
  assert.equal(c.lease.requireClaim, true);
});

test("task frontmatter", () => {
  const t = parseTask("tasks/3-x.md", "---\nid: 3\ntitle: \"Daemon mode\"\npaths: [adapter/src/daemon/, README.md]\n---\nBody");
  assert.deepEqual(t, { id: "3", title: "Daemon mode", paths: ["adapter/src/daemon/", "README.md"], status: "open", body: "Body", file: "tasks/3-x.md" });
});
