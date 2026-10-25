/**
 * Each site's own rules for AI agents, delivered once per session.
 *
 * GravityKit Block MCP lets a site set "custom instructions": plain text, up
 * to 2,000 characters, saying how an agent must work on that site (voice,
 * content only, how to undo a write). Block MCP 2.2.1 hands them only to its
 * own Node server, at initialize. An agent on this router never saw them,
 * while the Weave playbook said every agent reads them at connect (Roots &
 * Fruit review, 26 October 2026). So the router looks a site's rules up once
 * per session and attaches them, labelled, to the first wp_run result on that
 * site.
 *
 * Where the text comes from, in order:
 *   1. `agent_instructions` in weave/get-site-info (weave-abilities after
 *      0.9.4), over the MCP session the router already holds.
 *   2. Block MCP's public route `/wp-json/gk-block-api/v1/instructions`, for
 *      sites on older weave-abilities or without it. A 404 there means Block
 *      MCP is not on the site, so there is nothing to send.
 *
 * It must never get in the way of the call it rides on. The lookup runs
 * alongside the agent's call inside a short budget, a failure adds one short
 * note and is tried again on the next wp_run (a few tries a session at most),
 * and the text is capped at Block MCP's own 2,000 characters.
 */

import type { FleetConfig } from "./config.js";
import type { Catalog } from "./catalog.js";
import { EXECUTE_TOOL } from "./catalog.js";

export const SITE_INFO_ABILITY = "weave/get-site-info";
export const INSTRUCTIONS_ROUTE = "/gk-block-api/v1/instructions";

/** Block MCP's own cap (Instructions::MAX_LENGTH, 2.2.1), in characters. */
export const MAX_RULES_CHARS = 2000;
/** Default budget for one lookup, both sources together. */
export const DEFAULT_RULES_TIMEOUT_MS = 5000;
/** Failed lookups allowed per site per session before the router stops trying. */
export const MAX_ATTEMPTS = 3;

export type RulesLookup =
  | { kind: "found"; text: string; updatedAt?: string; source: string }
  | { kind: "empty"; source: string }
  | { kind: "absent" }
  | { kind: "failed"; reason: string };

/** What a wp_run result gains: nothing, the rules, or a short note. */
export type RulesAttachment =
  | { site_rules: Record<string, string> }
  | { site_rules_note: string }
  | Record<string, never>;

type SiteState =
  | { status: "idle"; attempts: number }
  | { status: "inflight"; attempts: number }
  | { status: "sent"; lookup: RulesLookup }
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
 * so the caller falls back to the route.
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

/** Shape a lookup into the fields a wp_run result gains. */
export function attachmentFor(siteId: string, lookup: RulesLookup, lastTry: boolean): RulesAttachment {
  switch (lookup.kind) {
    case "found":
      return {
        site_rules: {
          about:
            `The rules this site's administrators set for AI agents (Block MCP custom instructions on ${siteId}). ` +
            "Follow them for every call on this site. If the call in this result changed anything, check it against them now. Sent once per session, with the first wp_run here.",
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
   * Claim the right to attach rules to this wp_run. Returns null when there is
   * nothing to do: rules already sent, none on the site, gave up, or another
   * call on the site holds the claim. Otherwise the lookup starts now, beside
   * the agent's call, unless that call is weave/get-site-info itself, whose own
   * result carries the field.
   */
  begin(siteId: string, abilityName: string): RulesClaim | null {
    if (!this.enabled) return null;
    const current = this.state.get(siteId) ?? { status: "idle", attempts: 0 };
    if (current.status !== "idle") return null;
    const attempts = current.attempts;
    this.state.set(siteId, { status: "inflight", attempts });

    const deadline = Date.now() + this.timeoutMs;
    const early = abilityName === SITE_INFO_ABILITY ? null : this.bounded(this.lookup(siteId, deadline), deadline);

    return {
      release: () => this.state.set(siteId, { status: "idle", attempts }),
      finish: async (result: unknown) => {
        let lookup: RulesLookup;
        try {
          if (early) {
            lookup = await early;
          } else {
            // The agent's own call was get-site-info: read its result, and only
            // go to the route if the field is not there. Fresh budget, since
            // nothing ran alongside the call.
            const fromResult = rulesFromSiteInfo(result);
            const late = Date.now() + this.timeoutMs;
            lookup = fromResult ?? (await this.bounded(this.fromRoute(siteId, late), late));
          }
        } catch (err) {
          // Nothing above should throw. If it does, it is a note, not a failed call.
          lookup = { kind: "failed", reason: shortReason(err) };
        }
        return this.settle(siteId, lookup, attempts);
      },
    };
  }

  /** What wp_list_sites can say about a site without a request. */
  status(siteId: string): string | undefined {
    const s = this.state.get(siteId);
    if (!s) return undefined;
    switch (s.status) {
      case "sent":
        return s.lookup.kind === "found" ? "sent with the first wp_run" : "Block MCP active, no rules set";
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
    if (siteId) this.state.delete(siteId);
    else this.state.clear();
  }

  private settle(siteId: string, lookup: RulesLookup, attempts: number): RulesAttachment {
    if (lookup.kind === "failed") {
      const tries = attempts + 1;
      const lastTry = tries >= MAX_ATTEMPTS;
      this.state.set(siteId, lastTry ? { status: "given-up", reason: lookup.reason } : { status: "idle", attempts: tries });
      return attachmentFor(siteId, lookup, lastTry);
    }
    this.state.set(siteId, lookup.kind === "absent" ? { status: "none" } : { status: "sent", lookup });
    return attachmentFor(siteId, lookup, false);
  }

  /** get-site-info first when the site has it, then the public route. */
  private async lookup(siteId: string, deadline: number): Promise<RulesLookup> {
    const cat = await this.catalog.getCatalog(siteId);
    if (cat.byName.has(SITE_INFO_ABILITY)) {
      try {
        const result = await this.catalog
          .client(siteId)
          .callTool(EXECUTE_TOOL, { ability_name: SITE_INFO_ABILITY, parameters: {} }, { timeoutMs: remaining(deadline) });
        const fromInfo = rulesFromSiteInfo(result);
        if (fromInfo) return fromInfo;
      } catch {
        // Fall through to the route: it may still answer.
      }
    }
    return this.fromRoute(siteId, deadline);
  }

  private async fromRoute(siteId: string, deadline: number): Promise<RulesLookup> {
    try {
      const { status, body } = await this.catalog.client(siteId).restGet(INSTRUCTIONS_ROUTE, remaining(deadline));
      return rulesFromRoute(status, body);
    } catch (err) {
      return { kind: "failed", reason: shortReason(err) };
    }
  }

  /** Hard cap: whatever happens underneath, a lookup answers by the deadline. */
  private bounded(work: Promise<RulesLookup>, deadline: number): Promise<RulesLookup> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RulesLookup>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "failed", reason: `no answer within ${budgetLabel(this.timeoutMs)}` }),
        remaining(deadline),
      );
    });
    return Promise.race([work.catch((err) => ({ kind: "failed" as const, reason: shortReason(err) })), timeout]).finally(
      () => clearTimeout(timer),
    );
  }
}

export interface RulesClaim {
  /** The agent's call threw: give the claim back so the next call can try. */
  release(): void;
  /** The agent's call returned: wait for the lookup (bounded) and shape it. */
  finish(result: unknown): Promise<RulesAttachment>;
}

function budgetLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} seconds`;
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function shortReason(err: unknown): string {
  const msg = String((err as Error)?.message ?? err).replace(/^\[[^\]]+\]\s*/, "");
  return msg.length > 160 ? msg.slice(0, 157) + "..." : msg;
}
