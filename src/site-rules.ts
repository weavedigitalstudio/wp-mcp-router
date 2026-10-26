/**
 * Each site's own rules for AI agents, delivered once per session.
 *
 * GravityKit Block MCP lets a site set "custom instructions": plain text, up
 * to 2,000 characters, saying how an agent must work on that site (voice,
 * content only, how to undo a write). Block MCP 2.2.1 hands them only to its
 * own Node server, at initialize. An agent on this router never saw them,
 * while the Weave playbook said every agent reads them at connect (Roots &
 * Fruit review, 26 October 2026). So the router looks a site's rules up once
 * per session and attaches them, labelled, to a wp_run result on that site.
 *
 * Where the text comes from. Both sources are asked at once, so an answer
 * takes one round trip, not two:
 *   1. Block MCP's public route `/wp-json/gk-block-api/v1/instructions`, sent
 *      first. On sites running weave-abilities 0.9.4 or earlier it is the only
 *      source. A 404 there means Block MCP is not on the site, so there is
 *      nothing to send.
 *   2. `agent_instructions` in weave/get-site-info (weave-abilities after
 *      0.9.4), over the MCP session the router already holds. It is the same
 *      text, so it is used whenever it has come in, and it covers a site whose
 *      route is blocked or rate-limited. When the agent's own call is
 *      get-site-info, its result is read instead of asking twice.
 *
 * It must never get in the way of the call it rides on. The lookup starts with
 * the agent's call and runs on its own: when the call returns, the rules go
 * with it if they are ready, and otherwise with the next wp_run on the site,
 * marked late. Nothing ever waits for the lookup. The first version asked the
 * two sources one after the other and held the agent's result until they
 * answered, up to 5 seconds, so a slow site paid that on each of its first
 * wp_runs (review of 780cda7, 26 October 2026).
 *
 * A failure adds one short note and is tried again on a later wp_run (a few
 * tries a session at most), and the text is capped at Block MCP's own 2,000
 * characters.
 */

import type { FleetConfig } from "./config.js";
import type { Catalog } from "./catalog.js";
import { EXECUTE_TOOL } from "./catalog.js";

export const SITE_INFO_ABILITY = "weave/get-site-info";
export const INSTRUCTIONS_ROUTE = "/gk-block-api/v1/instructions";

/** Block MCP's own cap (Instructions::MAX_LENGTH, 2.2.1), in characters. */
export const MAX_RULES_CHARS = 2000;
/** Default time a lookup gets, both sources together, before it counts as failed. */
export const DEFAULT_RULES_TIMEOUT_MS = 5000;
/** Failed lookups allowed per site per session before the router stops trying. */
export const MAX_ATTEMPTS = 3;
/**
 * The two requests may run this long past the lookup's deadline, so the
 * deadline itself always decides first and the note names the budget rather
 * than a network timeout.
 */
const REQUEST_GRACE_MS = 100;

export type RulesLookup =
  | { kind: "found"; text: string; updatedAt?: string; source: string }
  | { kind: "empty"; source: string }
  | { kind: "absent" }
  | { kind: "failed"; reason: string };

/** get-site-info's side of a lookup: not in yet, its field, or no field at all. */
export type InfoAnswer = RulesLookup | "pending" | "none";
/** The route's side of a lookup: not in yet, or its answer. */
export type RouteAnswer = RulesLookup | "pending";

/** What a wp_run result gains: nothing, the rules, a short note, or word that they are on the way. */
export type RulesAttachment =
  | { site_rules: Record<string, string> }
  | { site_rules_note: string }
  | { site_rules_pending: string }
  | Record<string, never>;

/** One lookup of one site's rules, both sources at once. */
interface Job {
  info: InfoAnswer;
  route: RouteAnswer;
  /** The decided answer, once there is one. */
  answer?: RulesLookup;
  /** wp_run calls on the site that went back to the agent before the answer was ready. */
  ranWithout: number;
  /** Failed lookups on the site before this one. */
  attempts: number;
  /** The agent's own call is get-site-info, so the router sent none of its own. */
  waitsOnCall: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

type SiteState =
  | { status: "idle"; attempts: number }
  | { status: "looking"; job: Job }
  | { status: "sent"; lookup: RulesLookup; late: boolean }
  | { status: "none" }
  | { status: "given-up"; reason: string };

/**
 * Strip what has no place in agent rules, then cap. Block MCP strips tags and
 * ASCII controls on save; its Node server also drops zero-width and bidi
 * characters, which carry the most prompt-injection risk, so we do the same.
 */
export function cleanRules(raw: string): string {
  let s = raw.replace(/\r\n?|\u2028|\u2029/g, "\n");
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "");
  s = s.trim();
  const chars = [...s];
  if (chars.length > MAX_RULES_CHARS) {
    s = chars.slice(0, MAX_RULES_CHARS).join("") + " [cut at 2,000 characters]";
  }
  return s;
}

/** A unix timestamp (Block MCP's route) or an ISO string (get-site-info), as ISO. */
function isoTime(value: unknown): string | undefined {
  if (typeof value === "number" && value > 0) return new Date(value * 1000).toISOString().replace(".000Z", "Z");
  if (typeof value === "string" && value) return value;
  return undefined;
}

/** The ability's output inside an mcp-adapter execute-ability envelope. */
function abilityOutput(result: any): any {
  if (result?.isError) return undefined;
  const textNode = Array.isArray(result?.content)
    ? result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")
    : undefined;
  let payload: any = result?.structuredContent;
  if (textNode) {
    try {
      payload = JSON.parse(textNode.text);
    } catch {
      return undefined;
    }
  }
  return payload?.data ?? payload;
}

/**
 * Read the rules out of a weave/get-site-info result. Undefined when the
 * field is missing (weave-abilities 0.9.4 or earlier, or Block MCP inactive),
 * so the route's answer stands.
 */
export function rulesFromSiteInfo(result: unknown): RulesLookup | undefined {
  const field = abilityOutput(result)?.agent_instructions;
  if (!field || typeof field !== "object" || typeof field.text !== "string") return undefined;
  const text = cleanRules(field.text);
  if (!text) return { kind: "empty", source: SITE_INFO_ABILITY };
  return { kind: "found", text, updatedAt: isoTime(field.updated_at), source: SITE_INFO_ABILITY };
}

/** Read the rules out of a response from Block MCP's instructions route. */
export function rulesFromRoute(status: number, body: any): RulesLookup {
  const source = `/wp-json${INSTRUCTIONS_ROUTE}`;
  if (status === 404) return { kind: "absent" };
  if (status === 429) return { kind: "failed", reason: "the site rate-limited the instructions route" };
  if (status !== 200) return { kind: "failed", reason: `the instructions route answered HTTP ${status}` };
  if (!body || typeof body !== "object" || typeof body.addendum !== "string") {
    return { kind: "failed", reason: "the instructions route did not answer with JSON" };
  }
  const text = cleanRules(body.addendum);
  if (!text) return { kind: "empty", source };
  return { kind: "found", text, updatedAt: isoTime(body.updated_at), source };
}

function isText(answer: InfoAnswer | RouteAnswer): answer is Extract<RulesLookup, { kind: "found" | "empty" }> {
  return typeof answer === "object" && (answer.kind === "found" || answer.kind === "empty");
}

/**
 * What the two sources say together, or undefined while that is not clear
 * yet. get-site-info's field wins, since it is the same text. A route answer
 * that carries the instructions (or says none are set) is enough on its own,
 * so the rules never wait on a second round trip. A 404 or a failure from the
 * route waits for get-site-info, which may still have the field. `final` is
 * the deadline: decide with whatever has come in.
 */
export function decideRules(info: InfoAnswer, route: RouteAnswer, final: boolean, budget: string): RulesLookup | undefined {
  if (isText(info)) return info;
  if (isText(route)) return route;
  if (!final && (info === "pending" || route === "pending")) return undefined;
  if (route === "pending") return { kind: "failed", reason: `no answer within ${budget}` };
  return route;
}

/** The line a late delivery adds, so the agent checks what already ran. */
function lateLine(siteId: string, ranWithout: number): string {
  const earlier = ranWithout === 1 ? "1 earlier wp_run" : `${ranWithout} earlier wp_run calls`;
  return (
    `These arrived late: they were not ready when your first wp_run on ${siteId} returned, so they come with this one. ` +
    `${earlier} on ${siteId} ran without them. Check anything ${ranWithout === 1 ? "it" : "they"} changed against them now.`
  );
}

/** Shape a lookup into the fields a wp_run result gains. */
export function attachmentFor(siteId: string, lookup: RulesLookup, lastTry: boolean, ranWithout = 0): RulesAttachment {
  switch (lookup.kind) {
    case "found":
      return {
        site_rules: {
          about:
            `The rules this site's administrators set for AI agents (Block MCP custom instructions on ${siteId}). ` +
            "Follow them for every call on this site. If the call in this result changed anything, check it against them now. Sent once per session.",
          ...(ranWithout > 0 ? { arrived_late: lateLine(siteId, ranWithout) } : {}),
          source: lookup.source,
          ...(lookup.updatedAt ? { updated_at: lookup.updatedAt } : {}),
          text: lookup.text,
        },
      };
    case "empty":
      return {
        site_rules: {
          about: `Block MCP is active on ${siteId} but its custom instructions are empty, so this site sets no agent rules. Tell a person if you expected some.`,
          source: lookup.source,
        },
      };
    case "absent":
      return {};
    case "failed":
      return {
        site_rules_note:
          `Could not read ${siteId}'s agent rules: ${lookup.reason}. The call itself ran as normal. ` +
          (lastTry ? "Not trying again this session." : "Trying again with the next wp_run on this site."),
      };
  }
}

export class SiteRules {
  private state = new Map<string, SiteState>();
  private readonly timeoutMs: number;
  private readonly enabled: boolean;

  constructor(
    config: FleetConfig,
    private readonly catalog: Catalog,
  ) {
    const t = config.rulesTimeoutMs;
    this.timeoutMs = typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_RULES_TIMEOUT_MS;
    this.enabled = config.siteRules !== false;
  }

  /**
   * Called as a wp_run starts. Returns null when there is nothing to do: the
   * rules already went out, the site has none, or the router gave up on it.
   * Otherwise it starts a lookup if none is running, and returns a claim the
   * call settles when it ends. The claim never waits: it attaches the answer
   * if it is in by then and leaves it for the next wp_run if not.
   */
  begin(siteId: string, abilityName: string): RulesClaim | null {
    if (!this.enabled) return null;
    let current: SiteState = this.state.get(siteId) ?? { status: "idle", attempts: 0 };
    const readsInfo = abilityName === SITE_INFO_ABILITY;
    if (current.status === "idle") {
      current = { status: "looking", job: this.start(siteId, current.attempts, readsInfo) };
      this.state.set(siteId, current);
    }
    if (current.status !== "looking") return null;

    // The agent's own get-site-info result is a source in its own right. It
    // goes to whichever lookup is running when the call ends.
    const feed = (result: unknown) => {
      const s = this.state.get(siteId);
      if (readsInfo && s?.status === "looking") this.infoFromCall(s.job, result);
    };
    return {
      release: () => {
        feed(undefined);
        this.deliver(siteId, false);
      },
      finish: (result: unknown) => {
        feed(result);
        return this.deliver(siteId, true);
      },
    };
  }

  /** What wp_list_sites can say about a site without a request. */
  status(siteId: string): string | undefined {
    const s = this.state.get(siteId);
    if (!s) return undefined;
    switch (s.status) {
      case "looking": {
        const a = s.job.answer;
        if (!a) return "looking up";
        if (a.kind === "absent") return "none (no Block MCP)";
        if (a.kind === "failed") return `lookup failed (${a.reason})`;
        return "ready, goes out with the next wp_run";
      }
      case "sent":
        if (s.lookup.kind !== "found") return "Block MCP active, no rules set";
        return s.late ? "sent late, with a later wp_run" : "sent with the first wp_run";
      case "none":
        return "none (no Block MCP)";
      case "given-up":
        return `unreadable this session (${s.reason})`;
      default:
        return undefined;
    }
  }

  /** Forget what was sent, so the next wp_run on the site sends the rules again. */
  reset(siteId?: string): void {
    for (const [id, s] of this.state) {
      if ((!siteId || id === siteId) && s.status === "looking") clearTimeout(s.job.timer);
    }
    if (siteId) this.state.delete(siteId);
    else this.state.clear();
  }

  /**
   * Ask both sources now, the route first. Neither request is awaited here:
   * each answer lands on the job as it comes in. `readsInfo` means the
   * agent's own call is get-site-info, so its result stands in for ours.
   */
  private start(siteId: string, attempts: number, readsInfo: boolean): Job {
    const job: Job = { info: "pending", route: "pending", ranWithout: 0, attempts, waitsOnCall: readsInfo };
    const deadline = Date.now() + this.timeoutMs;
    job.timer = setTimeout(() => {
      job.answer ??= decideRules(job.info, job.route, true, budgetLabel(this.timeoutMs));
    }, this.timeoutMs);
    // A lookup must never keep the process alive on its own.
    job.timer.unref?.();

    void this.fromRoute(siteId, deadline).then((route) => {
      job.route = route;
      this.update(job);
    });
    if (!readsInfo) {
      void this.fromSiteInfo(siteId, deadline).then((info) => {
        if (job.info === "pending" || (info !== "none" && !isText(job.info))) job.info = info;
        this.update(job);
      });
    }
    return job;
  }

  /**
   * Fold a get-site-info result from the agent's own call into the job. A
   * result without the field only counts as "none" when the job was waiting
   * on this call; otherwise the router's own request still decides.
   */
  private infoFromCall(job: Job, result: unknown): void {
    if (isText(job.info)) return;
    const fromResult = result === undefined ? undefined : rulesFromSiteInfo(result);
    if (fromResult) job.info = fromResult;
    else if (job.info === "pending" && job.waitsOnCall) job.info = "none";
    this.update(job);
  }

  private update(job: Job): void {
    if (job.answer) return;
    job.answer = decideRules(job.info, job.route, false, budgetLabel(this.timeoutMs));
    if (job.answer) clearTimeout(job.timer);
  }

  /**
   * A wp_run on the site has ended. If the answer is in, it goes out now
   * (get-site-info's field when that came in too, and rules that came in
   * after the deadline rather than the failure it recorded) and the site's
   * state moves on. If not, the call is counted as one that ran without the
   * rules, and its result says they are on the way, so an agent about to
   * write knows to read once more first. A call that threw (`returned`
   * false) has no result to carry anything.
   */
  private deliver(siteId: string, returned: boolean): RulesAttachment {
    const s = this.state.get(siteId);
    if (s?.status !== "looking") return {};
    const job = s.job;
    if (!returned) {
      job.ranWithout++;
      return {};
    }
    if (!job.answer) {
      job.ranWithout++;
      return {
        site_rules_pending:
          `${siteId}'s agent rules are still being looked up. The router does not wait for them: they come with the next wp_run on this site. ` +
          "Make that a read if you were about to write.",
      };
    }
    // What has come in by now beats what was recorded: get-site-info's field
    // over the route's copy, and text that landed after the deadline (inside
    // the request grace) over the failure the deadline wrote. A failure keeps
    // the deadline's wording, which names the budget.
    const latest = decideRules(job.info, job.route, true, budgetLabel(this.timeoutMs));
    const lookup: RulesLookup = latest?.kind === "found" || latest?.kind === "empty" ? latest : job.answer;
    clearTimeout(job.timer);
    if (lookup.kind === "failed") {
      const tries = job.attempts + 1;
      const lastTry = tries >= MAX_ATTEMPTS;
      this.state.set(siteId, lastTry ? { status: "given-up", reason: lookup.reason } : { status: "idle", attempts: tries });
      return attachmentFor(siteId, lookup, lastTry);
    }
    this.state.set(siteId, lookup.kind === "absent" ? { status: "none" } : { status: "sent", lookup, late: job.ranWithout > 0 });
    return attachmentFor(siteId, lookup, false, job.ranWithout);
  }

  /** get-site-info's field, or "none" when the site has no field, no ability, or did not answer. */
  private async fromSiteInfo(siteId: string, deadline: number): Promise<InfoAnswer> {
    try {
      const cat = await this.catalog.getCatalog(siteId);
      if (!cat.byName.has(SITE_INFO_ABILITY)) return "none";
      const result = await this.catalog
        .client(siteId)
        .callTool(EXECUTE_TOOL, { ability_name: SITE_INFO_ABILITY, parameters: {} }, { timeoutMs: remaining(deadline) });
      return rulesFromSiteInfo(result) ?? "none";
    } catch {
      return "none"; // The route may still answer.
    }
  }

  private async fromRoute(siteId: string, deadline: number): Promise<RulesLookup> {
    try {
      const { status, body } = await this.catalog.client(siteId).restGet(INSTRUCTIONS_ROUTE, remaining(deadline));
      return rulesFromRoute(status, body);
    } catch (err) {
      return { kind: "failed", reason: shortReason(err) };
    }
  }
}

export interface RulesClaim {
  /** The agent's call threw. The lookup carries on, and its answer goes out with a later wp_run. */
  release(): void;
  /** The agent's call returned. Attaches the rules if they are in, and never waits for them. */
  finish(result: unknown): RulesAttachment;
}

function budgetLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} seconds`;
}

/** Time left before the deadline, plus the grace that lets the deadline decide first. */
function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now()) + REQUEST_GRACE_MS;
}

function shortReason(err: unknown): string {
  const msg = String((err as Error)?.message ?? err).replace(/^\[[^\]]+\]\s*/, "");
  return msg.length > 160 ? msg.slice(0, 157) + "..." : msg;
}
