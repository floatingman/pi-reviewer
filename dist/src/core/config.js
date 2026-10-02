import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_MAX_CHARS } from "./diff-filter.js";
export const CONFIG_DIR = join(homedir(), ".pi", "pi-reviewer");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export function readConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
    catch {
        return {};
    }
}
export function saveConfig(config) {
    try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    }
    catch { /* ignore */ }
}
const VALID = {
    theme: ["dark", "light"],
    viewMode: ["split", "unified"],
    thinking: ["off", "minimal", "low", "medium", "high", "xhigh"],
    minSeverity: ["INFO", "WARN", "CRITICAL"],
};
export function applyConfigPatch(patch) {
    const next = { ...readConfig() };
    for (const key of Object.keys(patch)) {
        const value = patch[key];
        const allowed = VALID[key];
        if (allowed) {
            if (typeof value === "string" && allowed.includes(value))
                next[key] = value;
        }
        else if (key === "branch") {
            if (typeof value === "string")
                next.branch = value || undefined;
        }
        else if (key === "maxDiffChars") {
            if (typeof value === "number" && Number.isInteger(value) && value > 0)
                next.maxDiffChars = value;
        }
        else if (typeof value === "string" || typeof value === "boolean") {
            next[key] = value;
        }
    }
    saveConfig(next);
}
export function readTheme() { return readConfig().theme ?? "dark"; }
/** Effective diff size cap: CLI flag > config file > built-in default. */
export function resolveMaxDiffChars(cliValue) {
    if (typeof cliValue === "number" && Number.isInteger(cliValue) && cliValue > 0)
        return cliValue;
    const configured = readConfig().maxDiffChars;
    if (typeof configured === "number" && Number.isInteger(configured) && configured > 0)
        return configured;
    return DEFAULT_MAX_CHARS;
}
export function readViewMode() { return readConfig().viewMode ?? "split"; }
export function readVerbose() { return readConfig().verbose ?? false; }
export function readMinSeverity() { return readConfig().minSeverity ?? "INFO"; }
export function readModel() { return readConfig().model; }
export function readThinking() { return readConfig().thinking; }
export function readAutoCollapseViewed() { return readConfig().autoCollapseViewed ?? false; }
export function readDefaultBranch() { return readConfig().branch; }
