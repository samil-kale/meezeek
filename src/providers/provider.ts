import type { RemoteRepository } from "../shared/types";

/**
 * What a repository host has to offer meezeek: authenticate, list repositories, and — through
 * the listing — the url a repository is cloned from. Everything past the clone goes through
 * the local git CLI like any other repository; a provider never touches a working tree.
 */
export interface GitProvider {
  /** Checks the token against the host and answers the login it belongs to. */
  validate(host: string, token: string): Promise<string>;
  /** Every repository the token's user can reach, most recently active first. */
  listRepositories(host: string, token: string): Promise<RemoteRepository[]>;
}

/**
 * Pages are followed through the RFC 5988 `Link` header, which GitHub and GitLab both send.
 * The cap bounds an account that can reach thousands of repositories — ten pages of a hundred
 * are more than a picker's search field needs.
 */
const PAGE_CAP = 10;

/** One GET as JSON; a non-2xx status becomes an Error carrying what the API said. */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(await apiError(response));
  }
  return response.json();
}

/** Follows `Link: rel="next"` from the first page until the cap, collecting array bodies. */
export async function getPaged(first: string, headers: Record<string, string>): Promise<unknown[]> {
  const items: unknown[] = [];
  let url: string | undefined = first;
  for (let page = 0; url !== undefined && page < PAGE_CAP; page++) {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(await apiError(response));
    }
    const body = (await response.json()) as unknown;
    if (Array.isArray(body)) {
      items.push(...body);
    }
    url = nextLink(response.headers.get("link"));
  }
  return items;
}

function nextLink(header: string | null): string | undefined {
  const match = /<([^>]+)>;\s*rel="next"/.exec(header ?? "");
  return match?.[1];
}

/** Both APIs put their reason in a `message` field; the status line is the fallback. */
async function apiError(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") {
      return `${body.message} (${status})`;
    }
  } catch {
    // Not JSON — a proxy's error page, say. The status line is all there is.
  }
  return status;
}
