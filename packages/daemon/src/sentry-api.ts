/**
 * Sentry API client — fetch issue details and format stack traces.
 *
 * The daemon fetches Sentry context *before* spawning Ray so that
 * credentials stay out of agent sessions. Ray receives a fully-formed
 * prompt with all the data it needs.
 */

// ── Types ──

export interface SentryStackFrame {
  filename?: string;
  function?: string;
  lineNo?: number;
  colNo?: number;
  context?: Array<[number, string]>;
  inApp?: boolean;
}

export interface SentryException {
  type?: string;
  value?: string;
  stacktrace?: {
    frames?: SentryStackFrame[];
  };
}

export interface SentryIssueDetails {
  title: string;
  culprit: string;
  level: string;
  count: string;
  first_seen: string;
  last_seen: string;
  platform: string;
  web_url: string;
  tags: Array<{ key: string; value: string }>;
  stack_trace: string;
  contexts: Record<string, unknown>;
  request?: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  user?: {
    id?: string;
    email?: string;
    ip_address?: string;
  };
}

// ── Stack trace formatting ──

/**
 * Extract a readable stack trace from a Sentry event payload.
 *
 * Sentry events nest exceptions inside exception.values[]. We take
 * the first (outermost) exception and its frames, filter to in-app
 * frames when possible, and render them as a readable text block.
 */
export function format_stack_trace(event: Record<string, unknown>): string {
  const exception_entry = event.exception as Record<string, unknown> | undefined;
  const exception_values = exception_entry?.values as SentryException[] | undefined;

  if (!exception_values?.length) {
    // Fall back to message-only events (e.g. console.error captures)
    const message = event.message as string | undefined;
    return message ? `(no stack trace — message event)\n${message}` : "(no stack trace)";
  }

  const lines: string[] = [];

  for (const exc of exception_values) {
    if (exc.type || exc.value) {
      lines.push(`${exc.type ?? "Error"}: ${exc.value ?? "(no message)"}`);
    }

    const frames = exc.stacktrace?.frames;
    if (!frames?.length) {
      lines.push("  (no frames)");
      continue;
    }

    // Sentry frames are bottom-up (innermost last) — reverse for readability
    const reversed = [...frames].reverse();

    // Prefer in-app frames; fall back to all frames if none are marked in-app
    const in_app = reversed.filter((f) => f.inApp);
    const display_frames = in_app.length > 0 ? in_app : reversed;

    for (const frame of display_frames.slice(0, 20)) {
      const location = [frame.filename ?? "?", frame.lineNo, frame.colNo]
        .filter((v) => v != null)
        .join(":");
      const fn_name = frame.function ?? "<anonymous>";
      lines.push(`  at ${fn_name} (${location})`);

      // Include a snippet of surrounding context if available
      if (frame.context?.length) {
        for (const [line_no, code] of frame.context) {
          const marker = line_no === frame.lineNo ? ">" : " ";
          lines.push(`    ${marker} ${String(line_no).padStart(4)} | ${code}`);
        }
      }
    }

    if (display_frames.length > 20) {
      lines.push(`  ... (${String(display_frames.length - 20)} more frames omitted)`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── API client ──

/**
 * Fetch full Sentry issue details: metadata + latest event with stack trace.
 *
 * Uses `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` from the daemon environment
 * (injected via op run). Never passed through to agent sessions.
 */
export async function fetch_sentry_issue_details(
  issue_id: string,
  auth_token: string,
  org_slug: string,
): Promise<SentryIssueDetails> {
  const base_url = "https://sentry.io/api/0";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth_token}`,
    "Content-Type": "application/json",
  };

  // Fetch issue metadata (10s timeout to avoid hanging on Sentry outages)
  const issue_controller = new AbortController();
  const issue_timeout = setTimeout(() => issue_controller.abort(), 10_000);
  let issue_res: Response;
  try {
    issue_res = await fetch(`${base_url}/organizations/${org_slug}/issues/${issue_id}/`, {
      headers,
      signal: issue_controller.signal,
    });
  } finally {
    clearTimeout(issue_timeout);
  }

  if (!issue_res.ok) {
    throw new Error(
      `Sentry API error fetching issue ${issue_id}: ${String(issue_res.status)} ${issue_res.statusText}`,
    );
  }

  const issue = (await issue_res.json()) as Record<string, unknown>;

  // Fetch latest event for the stack trace (10s timeout)
  const event_controller = new AbortController();
  const event_timeout = setTimeout(() => event_controller.abort(), 10_000);
  let event_res: Response;
  try {
    event_res = await fetch(
      `${base_url}/organizations/${org_slug}/issues/${issue_id}/events/latest/`,
      { headers, signal: event_controller.signal },
    );
  } finally {
    clearTimeout(event_timeout);
  }

  let latest_event: Record<string, unknown> = {};
  if (event_res.ok) {
    latest_event = (await event_res.json()) as Record<string, unknown>;
  } else {
    console.warn(
      `[sentry-api] Could not fetch latest event for issue ${issue_id}: ` +
        `${String(event_res.status)} — proceeding without stack trace`,
    );
  }

  // Extract tags as a flat array (Sentry returns [{key, value}] already)
  const raw_tags = issue.tags as Array<Record<string, string>> | undefined;
  const tags = raw_tags?.map((t) => ({ key: t.key ?? "", value: t.value ?? "" })) ?? [];

  // Safely pull request context (could be null or absent)
  const raw_request = latest_event.request as Record<string, unknown> | null | undefined;
  const request = raw_request
    ? {
        method: raw_request.method as string | undefined,
        url: raw_request.url as string | undefined,
        headers: raw_request.headers as Record<string, string> | undefined,
      }
    : undefined;

  // User context included for completeness; not forwarded to agent sessions
  const raw_user = latest_event.user as Record<string, unknown> | null | undefined;
  const user = raw_user
    ? {
        id: raw_user.id as string | undefined,
        email: raw_user.email as string | undefined,
        ip_address: raw_user.ip_address as string | undefined,
      }
    : undefined;

  return {
    title: (issue.title as string) ?? "Unknown error",
    culprit: (issue.culprit as string) ?? "",
    level: (issue.level as string) ?? "error",
    count: String(issue.count ?? 0),
    first_seen: (issue.firstSeen as string) ?? "",
    last_seen: (issue.lastSeen as string) ?? "",
    platform: (issue.platform as string) ?? "",
    web_url: (issue.permalink as string) ?? (issue.web_url as string) ?? "",
    tags,
    stack_trace: format_stack_trace(latest_event),
    contexts: (latest_event.contexts as Record<string, unknown>) ?? {},
    request,
    user,
  };
}
