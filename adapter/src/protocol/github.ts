// GitHub Discussions transport. Token is injected by the caller: the adapter
// uses `gh auth token`, the VS Code extension uses vscode.authentication.
// No Node-only imports here — the extension bundles this file.

import { TASK_TITLE_RE, type RawComment } from "./message.js";

export interface DiscussionRef {
  id: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  task: string | null;
}

export interface Thread {
  discussion: DiscussionRef;
  comments: RawComment[];
}

export class GitHub {
  private repoMeta?: Promise<{ repositoryId: string; categoryId: string }>;

  constructor(
    private token: string,
    readonly owner: string,
    readonly name: string,
    private category: string,
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
    return json.data as T;
  }

  meta(): Promise<{ repositoryId: string; categoryId: string }> {
    this.repoMeta ??= this.graphql<{
      repository: { id: string; hasDiscussionsEnabled: boolean; discussionCategories: { nodes: { id: string; name: string }[] } };
    }>(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id hasDiscussionsEnabled
        discussionCategories(first:50){nodes{id name}}}}`,
      { owner: this.owner, name: this.name },
    ).then((d) => {
      const r = d.repository;
      if (!r.hasDiscussionsEnabled) throw new Error(`Discussions are disabled on ${this.owner}/${this.name}`);
      const cat = r.discussionCategories.nodes.find((c) => c.name.toLowerCase() === this.category.toLowerCase());
      if (!cat)
        throw new Error(
          `No Discussion category "${this.category}" in ${this.owner}/${this.name} (have: ${r.discussionCategories.nodes.map((c) => c.name).join(", ")})`,
        );
      return { repositoryId: r.id, categoryId: cat.id };
    });
    this.repoMeta.catch(() => (this.repoMeta = undefined));
    return this.repoMeta;
  }

  /** Task Discussions, most recently updated first. */
  async listTaskDiscussions(limit = 100): Promise<DiscussionRef[]> {
    const { categoryId } = await this.meta();
    const d = await this.graphql<{ repository: { discussions: { nodes: Omit<DiscussionRef, "task">[] } } }>(
      `query($owner:String!,$name:String!,$cat:ID!,$n:Int!){repository(owner:$owner,name:$name){
        discussions(first:$n,categoryId:$cat,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id number title url updatedAt}}}}`,
      { owner: this.owner, name: this.name, cat: categoryId, n: Math.min(limit, 100) },
    );
    return d.repository.discussions.nodes
      .map((n) => ({ ...n, task: TASK_TITLE_RE.exec(n.title)?.[1] ?? null }))
      .filter((n) => n.task !== null);
  }

  async findTaskDiscussion(task: string): Promise<DiscussionRef | null> {
    return (await this.listTaskDiscussions()).find((d) => d.task === task) ?? null;
  }

  /** All comments and replies on a Discussion, flattened, in creation order. */
  async comments(discussionNumber: number): Promise<RawComment[]> {
    type Node = { id: string; author: { login: string } | null; createdAt: string; url: string; body: string };
    type Page = {
      repository: {
        discussion: {
          comments: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: (Node & { replies: { nodes: Node[] } })[];
          };
        };
      };
    };
    const out: RawComment[] = [];
    let after: string | null = null;
    for (;;) {
      const d: Page = await this.graphql<Page>(
        `query($owner:String!,$name:String!,$num:Int!,$after:String){repository(owner:$owner,name:$name){
          discussion(number:$num){comments(first:100,after:$after){pageInfo{hasNextPage endCursor}
            nodes{id author{login} createdAt url body replies(first:100){nodes{id author{login} createdAt url body}}}}}}}`,
        { owner: this.owner, name: this.name, num: discussionNumber, after },
      );
      const page = d.repository.discussion.comments;
      for (const c of page.nodes) {
        out.push(toRaw(c));
        for (const r of c.replies.nodes) out.push(toRaw(r));
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  }

  async createTaskDiscussion(title: string, body: string): Promise<DiscussionRef> {
    const { repositoryId, categoryId } = await this.meta();
    const d = await this.graphql<{ createDiscussion: { discussion: Omit<DiscussionRef, "task"> } }>(
      `mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){
        discussion{id number title url updatedAt}}}`,
      { repo: repositoryId, cat: categoryId, title, body },
    );
    const disc = d.createDiscussion.discussion;
    return { ...disc, task: TASK_TITLE_RE.exec(disc.title)?.[1] ?? null };
  }

  async addComment(discussionId: string, body: string): Promise<RawComment> {
    const d = await this.graphql<{
      addDiscussionComment: { comment: { id: string; author: { login: string } | null; createdAt: string; url: string; body: string } };
    }>(
      `mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){
        comment{id author{login} createdAt url body}}}`,
      { id: discussionId, body },
    );
    return toRaw(d.addDiscussionComment.comment);
  }
}

function toRaw(c: { id: string; author: { login: string } | null; createdAt: string; url: string; body: string }): RawComment {
  return { id: c.id, author: c.author?.login ?? null, createdAt: c.createdAt, url: c.url, body: c.body };
}
