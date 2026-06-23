/**
 * GitHub fetcher for Agent Skills repositories.
 *
 * Uses the GitHub REST API to resolve a ref → commit, list the tree
 * recursively, then pulls raw contents for SKILL.md, commands/*.md,
 * and references/*.md files.
 *
 * Without a token: 60 req/h. With CODER_GITHUB_TOKEN: 5000 req/h.
 */

export interface FetchedRepoFile {
  path: string;
  content: string;
}

export interface FetchRepoResult {
  files: FetchedRepoFile[];
  commitSha: string;
}

interface GithubTreeNode {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

const WANT_RE = [
  /(^|\/)SKILL\.md$/i,
  /^commands\/[^/]+\.md$/i,
  /\/commands\/[^/]+\.md$/i,
  /\/references\/.+\.md$/i,
  /^\.mcp\.json$/i,
];

function isWanted(path: string): boolean {
  return WANT_RE.some((re) => re.test(path));
}

export async function fetchRepoSkillFiles(opts: {
  repo: string;
  ref?: string;
  token?: string;
}): Promise<FetchRepoResult> {
  const { repo, ref = 'HEAD', token } = opts;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid repo "${repo}": expected "owner/name"`);
  }
  const apiHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mcp-coder-skills',
  };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;

  // 1) Resolve ref → commit SHA
  const refRes = await fetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    { headers: apiHeaders },
  );
  if (!refRes.ok) {
    throw new Error(`GitHub API ${refRes.status}: failed to resolve ${repo}@${ref}`);
  }
  const commit = (await refRes.json()) as { sha: string };
  const commitSha = commit.sha;

  // 2) List tree recursively
  const treeRes = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/${commitSha}?recursive=1`,
    { headers: apiHeaders },
  );
  if (!treeRes.ok) {
    throw new Error(`GitHub API ${treeRes.status}: failed to list tree`);
  }
  const tree = (await treeRes.json()) as {
    tree: GithubTreeNode[];
    truncated?: boolean;
  };
  if (tree.truncated) {
    console.warn(`[github-fetcher] tree truncated for ${repo}@${commitSha}`);
  }

  const wanted = tree.tree.filter((n) => n.type === 'blob' && isWanted(n.path));

  // 3) Fetch raw content (batched to respect rate limits)
  const rawHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
  const files: FetchedRepoFile[] = [];
  for (let i = 0; i < wanted.length; i += 10) {
    const batch = wanted.slice(i, i + 10);
    const fetched = await Promise.all(
      batch.map(async (n) => {
        const rawRes = await fetch(
          `https://raw.githubusercontent.com/${repo}/${commitSha}/${n.path}`,
          { headers: rawHeaders },
        );
        if (!rawRes.ok) {
          throw new Error(`raw fetch ${rawRes.status} for ${n.path}`);
        }
        return { path: n.path, content: await rawRes.text() };
      }),
    );
    files.push(...fetched);
  }

  return { files, commitSha };
}
