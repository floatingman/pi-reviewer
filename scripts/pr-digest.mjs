#!/usr/bin/env node
/**
 * PR Review Digest - daily driver for the n8n "PR Review Digest" workflow.
 *
 * Collects PRs needing Daniel's review:
 *   1. PRs where floatingman is a requested reviewer (GitHub search)
 *   2. Open PRs in maintained repos (rancher/qa-infra-automation, rancher/qa-jenkins-library):
 *      flagged as team-requested (qa-pit-crew), no-reviewer, or other-open
 * Then drafts review replies using the pi-reviewer pipeline (same prompts/parser
 * as the /review skill) and prints a Markdown digest on stdout.
 *
 * Env: GH_TOKEN (or GITHUB_TOKEN), ZAI_API_KEY (GLM). Optional: DIGEST_MAX_REVIEWS.
 * Usage: node scripts/pr-digest.mjs [--reviews N] [--no-review] [--min-severity warn]
 */
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContext, mergeContextFiles } from "../dist/src/core/context.js";
import { buildJSONSystemPrompt, buildUserPrompt } from "../dist/src/core/prompt-builder.js";
import { parseAgentResponse } from "../dist/src/core/output.js";
import { existsSync as _exists, readFileSync as _read } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Per-repo accumulated review lessons (scripts/review-lessons/<owner_repo>.md).
// Injected into the review prompt as extra review_rules so the model gets
// smarter about each maintained repo over time.
const LESSONS_DIR = path.resolve(__dirname, "review-lessons");
const lessonsFor = (repo) => {
  const f = path.join(LESSONS_DIR, `${repo.replace("/", "_")}.md`);
  return _exists(f) ? _read(f, "utf8") : "";
};

const ME = "floatingman";
const TEAM = "qa-pit-crew";
const MAINTAINED = [
  { repo: "rancher/qa-infra-automation", mirror: "/home/dnewman/git/qa-infra-automation-mirror" },
  { repo: "rancher/qa-jenkins-library", mirror: "/home/dnewman/git/qa-jenkins-library-mirror" },
];
const MODEL = process.env.DIGEST_MODEL || "zai/glm-4.5";

// Author ignore list: one GitHub login per line in scripts/pr-digest.ignore (# comments allowed).
// PRs by these authors are excluded from the digest entirely.
import { readFileSync as _rf, existsSync as _ef } from "node:fs";
const IGNORE_FILE = path.resolve(__dirname, "pr-digest.ignore");
const IGNORED_AUTHORS = new Set(
  (_ef(IGNORE_FILE)
    ? _rf(IGNORE_FILE, "utf8").split("\n")
    : []
  )
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#")),
);
const isIgnored = (author) => IGNORED_AUTHORS.has(String(author || "").toLowerCase());

const GH = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!GH) { console.error("GH_TOKEN/GITHUB_TOKEN not set"); process.exit(1); }
const ZAI = process.env.ZAI_API_KEY;
if (!ZAI) { console.error("ZAI_API_KEY not set"); process.exit(1); }

const args = process.argv.slice(2);
const noReview = args.includes("--no-review");
const minSevIdx = args.indexOf("--min-severity");
const MIN_SEVERITY = minSevIdx >= 0 ? args[minSevIdx + 1] : "warn";
let maxReviews = 5;
const rIdx = args.indexOf("--reviews");
if (rIdx >= 0) maxReviews = parseInt(args[rIdx + 1], 10) || 5;
if (process.env.DIGEST_MAX_REVIEWS) maxReviews = parseInt(process.env.DIGEST_MAX_REVIEWS, 10) || maxReviews;

function ghApi(url) {
  const out = execSync(`curl -s -H "Authorization: Bearer ${GH}" "https://api.github.com${url}"`, {
    encoding: "utf8", timeout: 30000,
  });
  return JSON.parse(out);
}
function ghSearch(q) {
  const out = execSync(
    `curl -s -H "Authorization: Bearer ${GH}" "https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=50"`,
    { encoding: "utf8", timeout: 30000 },
  );
  return JSON.parse(out);
}
const ageDays = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));

// ---------- collect ----------
const byKey = new Map(); // "repo#num" -> pr record
function add(repo, num, title, author, url, why, priority, extra = {}) {
  const key = `${repo}#${num}`;
  const existing = byKey.get(key);
  const rec = { repo, num, title, author, url, why, priority, ageDays: ageDays(extra.created), draft: null, ...extra };
  if (!existing || existing.priority > priority) byKey.set(key, { ...existing, ...rec, priority });
  else if (existing) existing.why = existing.why || why;
}

// 1. personally requested (all of GitHub, in practice rancher org)
let ignoredCount = 0;
try {
  const res = ghSearch(`type:pr state:open review-requested:${ME}`);
  for (const it of res.items || []) {
    if (isIgnored(it.user.login)) { ignoredCount++; continue; }
    const repo = it.repository_url.replace("https://api.github.com/repos/", "");
    // fetch head SHA for same-day dedupe (search API doesn't include it)
    let headSha = null;
    try {
      const d = ghApi(`/repos/${repo}/pulls/${it.number}`);
      headSha = d.head?.sha || null;
    } catch { /* non-fatal */ }
    add(repo, it.number, it.title, it.user.login, it.html_url, "You are personally requested", 0, { created: it.created_at, updated: it.updated_at, headSha });
  }
} catch (e) { console.error("[digest] review-requested search failed:", e.message); }

// 2. maintained repos: every open PR, classified
for (const { repo } of MAINTAINED) {
  try {
    const prs = ghApi(`/repos/${repo}/pulls?state=open&per_page=50`);
    if (!Array.isArray(prs)) continue;
    for (const p of prs) {
      if (isIgnored(p.user.login)) { ignoredCount++; continue; }
      const teamReq = (p.requested_teams || []).some((t) => t.slug === TEAM);
      const personal = (p.requested_reviewers || []).some((r) => r.login === ME);
      const none = (p.requested_reviewers || []).length === 0 && (p.requested_teams || []).length === 0;
      let why, priority;
      if (personal) { why = `You are personally requested`; priority = 0; }
      else if (teamReq) { why = `Requested from team ${TEAM}`; priority = 1; }
      else if (none) { why = "No reviewers assigned (repo you maintain)"; priority = 2; }
      else { why = "Open in repo you maintain"; priority = 3; }
      add(repo, p.number, p.title, p.user.login, p.html_url, why, priority, {
        created: p.created_at, updated: p.updated_at, additions: p.additions, deletions: p.deletions,
        headSha: p.head?.sha || null,
        labels: (p.labels || []).map((l) => l.name).filter((n) => /renovate|dep/i.test(n)),
      });
    }
  } catch (e) { console.error(`[digest] ${repo} listing failed:`, e.message); }
}

const all = [...byKey.values()].sort((a, b) => a.priority - b.priority || b.ageDays - a.ageDays);

// skip renovate dependency bumps unless they are personally requested
const reviewable = all.filter((p) => p.priority === 0 || !p.isRenovate);
// mark renovate
for (const p of all) p.isRenovate = /renovate/i.test(p.author) || (p.labels || []).length > 0;

// ---------- skip PRs Daniel already reviewed on GitHub ----------
// A review by ME (approve / request-changes / comment) counts as handled.
// If the author pushed a new head SHA after the review, the PR returns:
// a re-review is then legitimate.
let reviewedByMeCount = 0;
for (const p of [...all]) {
  let reviews = [];
  try {
    reviews = ghApi(`/repos/${p.repo}/pulls/${p.num}/reviews?per_page=50`);
  } catch { /* non-fatal: keep the PR */ }
  if (!Array.isArray(reviews)) continue;
  const mine = reviews.filter((r) => r.user?.login === ME);
  if (!mine.length) continue;
  const newest = mine.reduce((a, b) => (a.submitted_at > b.submitted_at ? a : b));
  const reviewedCurrentHead = !p.headSha || newest.commit_id === p.headSha;
  if (reviewedCurrentHead) {
    reviewedByMeCount++;
    all.splice(all.indexOf(p), 1);
  }
}

// ---------- draft dedupe across same-day runs ----------
// State file records what was already drafted today (repo#num -> head SHA).
// Same-day re-runs (the 4 PM digest) skip unchanged PRs already drafted;
// anything from a previous day is re-drafted, so PRs still pending review
// reappear with a fresh draft in the next morning's digest.
const STATE_FILE = path.join(LESSONS_DIR, "..", ".digest-state.json");
const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
let prevState = {};
try { prevState = JSON.parse(_read(STATE_FILE, "utf8")); } catch { /* fresh */ }
if (prevState.date !== todayStr) prevState = { date: todayStr, drafted: {} };
prevState.drafted = prevState.drafted || {};
const alreadyDraftedToday = (key, sha) =>
  prevState.drafted[key] && prevState.drafted[key] === sha;

// Record why each reviewable PR got no draft this run, so the digest and the
// docs manifest can distinguish "already drafted earlier today" and "over the
// per-run cap" from actual drafting failures. Priority-3 PRs ("also open")
// are informational only and never drafted.
const LOW_PRIORITY_NOTE = "informational listing; not drafted (below review priorities)";
for (const p of all) {
  if (p.priority > 2 || p.isRenovate) continue;
  if (alreadyDraftedToday(`${p.repo}#${p.num}`, p.headSha)) p.noDraftReason = "dedupe";
}

// ---------- staleness gate: 90+ day PRs are never drafted ----------
// A PR unreviewed for 3+ months is not waiting on a daily draft; it needs a
// triage decision (review in one sitting, delegate, or close). Keep it listed
// with a note, but never let it consume a draft slot. Exception: activity in
// the last 14 days (author pushed / PR updated) means the author is re-engaged,
// so the PR re-qualifies for drafting.
const STALE_DAYS = 90;
const RECENT_ACTIVITY_DAYS = 14;
let staleCount = 0;
for (const p of all) {
  if (p.ageDays >= STALE_DAYS && p.priority <= 2 && !p.isRenovate) {
    if (p.updated && ageDays(p.updated) < RECENT_ACTIVITY_DAYS) continue; // re-engaged
    p.noDraftReason = "stale";
    staleCount++;
  }
}

const toReview = noReview ? [] : all
  .filter((p) => p.priority <= 2 && !p.isRenovate)
  .filter((p) => p.noDraftReason !== "stale")
  .filter((p) => !alreadyDraftedToday(`${p.repo}#${p.num}`, p.headSha))
  .slice(0, maxReviews);

// PRs past the cap (kept in `all`, listed in the digest, but not drafted).
for (const p of all) {
  if (p.priority > 3 || p.isRenovate) continue;
  if (p.priority === 3) { p.noDraftReason = "info"; continue; }
  if (!p.draft && !p.draftError && !p.noDraftReason && !toReview.includes(p)) {
    p.noDraftReason = "cap";
  }
}

// ---------- draft reviews (pi-reviewer pipeline) ----------
const [provId, modelId] = MODEL.split("/");
const registryModel = (() => {
  try { return getModel(provId, modelId); } catch { return null; }
})();
// Fall back to the glm-5 registry entry with the id swapped, so any model the
// API accepts (e.g. glm-5.3, newer releases missing from pi-ai's registry) works.
const model = registryModel ?? {
  ...getModel("zai", "glm-5"),
  id: modelId,
  name: modelId,
};

// Diff-size-aware review timeout: larger diffs need proportionally more time.
// Base 8 min for capped diffs (60k chars), scaled up to 20 min for the largest.
// A diff that cannot finish inside its size-adjusted budget is oversized for
// this pipeline and degrades to a "draft failed" note, as before.
const reviewTimeoutMs = (diffChars) => {
  const minutes = Math.min(20, Math.round(8 + (diffChars / 60000) * 6));
  return minutes * 60000;
};

async function draftReview(p) {
  const mirror = MAINTAINED.find((m) => m.repo === p.repo)?.mirror ?? process.cwd();
  const diff = execSync(
    `/home/dnewman/.local/bin/gh pr diff ${p.num} --repo ${p.repo}`,
    { encoding: "utf8", timeout: 60000, cwd: mirror, env: { ...process.env, GH_TOKEN: GH } },
  );
  if (!diff.trim()) throw new Error("empty diff");
  // size guard: cap the diff we ship to the model
  const capped = diff.length > 60000 ? diff.slice(0, 60000) + "\n... (diff truncated for digest review)" : diff;
  const hasMirror = MAINTAINED.some((m) => m.repo === p.repo);
  // keep mirrors fresh so AGENTS.md/conventions reflect the current default branch
  if (hasMirror) {
    try {
      execSync(`git fetch origin && git reset --hard origin/HEAD >/dev/null 2>&1 || git reset --hard origin/main`, { cwd: mirror, timeout: 60000, stdio: "ignore" });
    } catch { /* stale mirror is fine, just less context */ }
  }
  const lessons = hasMirror ? lessonsFor(p.repo) : "";
  const context = hasMirror
    ? await loadContext({ cwd: mirror })
    : { conventions: [], reviewRules: [], contextFiles: [] };
  if (lessons.trim()) {
    context.reviewRules = [...(context.reviewRules || []), { path: `review-lessons/${p.repo}.md`, content: lessons }];
  }
  const systemPrompt = buildJSONSystemPrompt(context, MIN_SEVERITY.toUpperCase());
  const userPrompt = buildUserPrompt(capped, []);
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: hasMirror ? createReadOnlyTools(mirror) : [],
      thinkingLevel: "high",
    },
    getApiKey: () => ZAI,
  });
  let finalResponse = "";
  let unsubscribe;
  const ended = new Promise((resolve, reject) => {
    unsubscribe = agent.subscribe((event) => {
      if (!event || event.type !== "agent_end") return;
      if (event.stopReason === "error") return reject(new Error(event.errorMessage ?? "agent error"));
      const msgs = event.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "assistant") continue;
        const c = typeof m.content === "string" ? m.content
          : Array.isArray(m.content) ? m.content.filter((x) => typeof x === "string" || x?.type === "text").map((x) => typeof x === "string" ? x : x.text).join("") : "";
        if (c.trim()) { finalResponse = c; break; }
      }
      finalResponse ? resolve() : reject(new Error("empty agent response"));
    });
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`review timeout (${Math.round(reviewTimeoutMs(capped.length) / 60000)} min)`)), reviewTimeoutMs(capped.length)));
  try {
    await Promise.race([agent.prompt(userPrompt).then(() => ended), timeout]);
  } catch (e) {
    try { agent.abort?.(); } catch { /* ignore */ }
    throw e;
  } finally { unsubscribe?.(); }
  const parsed = parseAgentResponse(finalResponse, MIN_SEVERITY.toUpperCase());
  // Some models return the JSON object verbatim as text; if the parser fell
  // through to treating it as the summary, re-parse it here.
  const raw = typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
  if (raw.startsWith("{")) {
    try {
      const re = JSON.parse(raw);
      if (re && (re.summary || re.comments)) return re;
    } catch { /* keep parsed as-is */ }
  }
  return parsed;
}

let drafted = 0;
for (const p of toReview) {
  try {
    process.stderr.write(`[digest] reviewing ${p.repo}#${p.num}...\n`);
    p.draft = await draftReview(p);
    drafted++;
    prevState.drafted[`${p.repo}#${p.num}`] = p.headSha;
  } catch (e) {
    p.draftError = e.message;
  }
}
// persist same-day dedupe state (atomic-ish write)
try {
  const { writeFileSync: _wf, mkdirSync: _mk } = await import("node:fs");
  _mk(path.dirname(STATE_FILE), { recursive: true });
  _wf(STATE_FILE, JSON.stringify(prevState, null, 2));
} catch (e) { console.error("[digest] state write failed:", e.message); }

// ---------- render digest (NO em/en dashes per Daniel's rule) ----------
const L = [];
const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" });
L.push(`# PR Review Digest - ${today}`);
L.push("");
const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
for (const p of all) counts[p.priority] = (counts[p.priority] || 0) + 1;
L.push(`Open PRs needing your attention: **${all.length}** (personally requested: ${counts[0]}, team ${TEAM}: ${counts[1]}, no reviewer in maintained repos: ${counts[2]}, other open in maintained repos: ${counts[3]})`);
if (ignoredCount > 0) L.push(`${ignoredCount} PR(s) by ignored authors (see scripts/pr-digest.ignore) were excluded.`);
if (reviewedByMeCount > 0) L.push(`${reviewedByMeCount} PR(s) you already reviewed on GitHub were skipped (they return if the author pushes new commits).`);
if (staleCount > 0) L.push(`${staleCount} stale PR(s) (90+ days old) were not drafted; triage them manually (review, delegate, or close).`);
L.push("");
const sections = [
  [0, "Requested from you directly"],
  [1, `Requested from team ${TEAM}`],
  [2, "No reviewers assigned (repos you maintain)"],
  [3, "Also open in repos you maintain"],
];
for (const [prio, heading] of sections) {
  const group = all.filter((p) => p.priority === prio);
  if (!group.length) continue;
  L.push(`## ${heading} (${group.length})`);
  L.push("");
  for (const p of group) {
    const size = p.additions != null ? ` (+${p.additions}/-${p.deletions})` : "";
    L.push(`### ${p.repo} #${p.num} - ${p.title}`);
    L.push(`by ${p.author}, opened ${p.ageDays}d ago${size}`);
    L.push(`${p.url}`);
    if (p.draft) {
      L.push("");
      L.push("**Draft review reply (pi-reviewer, edit before posting):**");
      L.push("");
      L.push(p.draft.summary || "");
      for (const c of p.draft.comments || []) {
        L.push(`- [${c.severity}] \`${c.file}:${c.line}\` ${c.body}`);
      }
    } else if (p.draftError) {
      L.push("");
      L.push(`_(draft failed: ${p.draftError})_`);
    } else if (p.noDraftReason === "dedupe") {
      L.push("");
      L.push(`_(draft already delivered earlier today; unchanged since then)_`);
    } else if (p.noDraftReason === "cap") {
      L.push("");
      L.push(`_(not drafted this run: daily review budget spent on higher-priority PRs)_`);
    } else if (p.noDraftReason === "stale") {
      L.push("");
      L.push(`_(stale: open ${p.ageDays} days without review. Triage manually: review in one sitting, delegate, or close. No draft until then.)_`);
    } else if (p.noDraftReason === "info") {
      L.push("");
      L.push(`_(informational listing; drafts focus on requested and unreviewed PRs)_`);
    }
    L.push("");
  }
}
if (!all.length) L.push("Nothing needs your review today. Nice.");
L.push("");
L.push(`_Drafted by pi-reviewer (${MODEL}) for ${drafted} of ${all.length} PRs. Replies are suggestions only, nothing was posted to GitHub._`);

const digest = L.join("\n").replace(/\u2014/g, "-").replace(/\u2013/g, "-");
console.log(digest);
