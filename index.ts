/**
 * pi-nativebar — a pi-powerbar-style status bar that reads Pi's native footer data.
 *
 * Same look & feel and settings keys as @juanibiapina/pi-powerbar (rendering ported
 * from it, MIT, (c) Juan Ibiapina), but instead of being event-fed it renders from
 * the live ExtensionContext + FooterDataProvider on every draw, so:
 *
 *   - git branch / extension status chips (e.g. @narumitw/pi-goal via ctx.ui.setStatus)
 *     come from the native footer data provider;
 *   - tokens / context usage come from ctx.sessionManager + ctx.getContextUsage();
 *   - model / provider / thinking level come from ctx.model + pi.getThinkingLevel();
 *   - any segment NOT built in can still be fed by other extensions via the
 *     `powerbar:update` / `powerbar:register-segment` events (same protocol as
 *     pi-powerbar), e.g. pi-usage's sub-hourly/sub-weekly.
 *
 * Settings are stored in settings-extensions.json (same file/format as
 * @juanibiapina/pi-extension-settings) under the key "powerbar" — byte-for-byte the
 * same registration name and settings key as @juanibiapina/pi-powerbar, so existing
 * powerbar settings are adopted directly and /extension-settings treats this
 * extension identically.
 * They are also registered with pi-extension-settings when that extension is
 * loaded, so /extension-settings can edit them.
 *
 * Settings are edited interactively via /extension-settings (pi-extension-settings),
 * exactly like pi-powerbar does; there is no dedicated command.
 */

import { existsSync, readFileSync, statSync, unwatchFile, watch, watchFile } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReadonlyFooterData = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
};

type EntryUsage = {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost: { total: number };
};

type TokenEntry = {
	type: string;
	id?: string;
	message?: { role?: string; usage?: EntryUsage };
	usage?: EntryUsage;
};

type ContextEntry = { tokens: number | null; contextWindow: number; percent: number | null };

interface Segment {
	id: string;
	/** Primary text, rendered before the bar. */
	text: string;
	/** Text rendered after the bar (e.g., "59%"). */
	suffix?: string;
	icon?: string;
	color?: string;
	/** If set, renders a progress bar. Value is 0–100. */
	bar?: number;
	/** Hint for how many discrete blocks to use in blocks mode. */
	barSegments?: number;
}

interface NativebarSettings {
	left: string[];
	right: string[];
	separator: string;
	placement: "aboveEditor" | "belowEditor";
	barWidth: number;
	barStyle: "continuous" | "blocks";
}

const EXTENSION_NAME = "powerbar";
const SETTINGS_FILE_NAME = "settings-extensions.json";

const DEFAULTS: Record<string, string> = {
	left: "git-branch,tokens,context-usage",
	right: "provider,model,status",
	separator: " │ ",
	placement: "belowEditor",
	"bar-style": "blocks",
	"bar-width": "10",
};

// ---------------------------------------------------------------------------
// Settings storage (settings-extensions.json, pi-extension-settings compatible)
// ---------------------------------------------------------------------------

type SettingsFile = Record<string, Record<string, string>>;

function loadSettingsFile(path: string): SettingsFile {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SettingsFile;
	} catch {
		return {};
	}
}

function readSetting(id: string, cwd: string): string | undefined {
	const files = [loadSettingsFile(join(cwd, ".pi", SETTINGS_FILE_NAME)), loadSettingsFile(join(getAgentDir(), SETTINGS_FILE_NAME))];
	for (const name of [EXTENSION_NAME]) {
		for (const file of files) {
			const value = file[name]?.[id];
			if (typeof value === "string" && value.length > 0) return value;
		}
	}
	return undefined;
}
function loadSettings(cwd: string): NativebarSettings {
	const leftStr = readSetting("left", cwd) ?? DEFAULTS.left;
	const rightStr = readSetting("right", cwd) ?? DEFAULTS.right;
	const separator = readSetting("separator", cwd) ?? DEFAULTS.separator;
	const placement = readSetting("placement", cwd) ?? DEFAULTS.placement;
	const barStyle = readSetting("bar-style", cwd) ?? DEFAULTS["bar-style"];
	const barWidthStr = readSetting("bar-width", cwd) ?? DEFAULTS["bar-width"];
	return {
		left: leftStr.split(",").map((s) => s.trim()).filter(Boolean),
		right: rightStr.split(",").map((s) => s.trim()).filter(Boolean),
		separator,
		placement: placement === "aboveEditor" ? "aboveEditor" : "belowEditor",
		barStyle: barStyle === "continuous" ? "continuous" : "blocks",
		barWidth: Math.max(4, Math.min(24, Number.parseInt(barWidthStr, 10) || 10)),
	};
}

// ---------------------------------------------------------------------------
// Token totals (incremental, adapted from pi-powerbar's tokens producer and
// pi's built-in FooterComponent)
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function extractUsage(entry: TokenEntry): { usage: EntryUsage; isAssistant: boolean } | undefined {
	if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) {
		const usage = entry.message?.usage;
		if (!usage) return undefined;
		return { usage, isAssistant: entry.message?.role === "assistant" };
	}
	if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
		return { usage: entry.usage, isAssistant: false };
	}
	return undefined;
}

interface TokenState {
	count: number;
	rootId: string | undefined;
	lastEntryId: string | undefined;
	leafId: string | null;
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	latestCacheHitRate: number | undefined;
}

function applyEntry(state: TokenState, entry: TokenEntry): void {
	const extracted = extractUsage(entry);
	if (!extracted) return;
	const usage = extracted.usage;
	state.totalInput += usage.input;
	state.totalOutput += usage.output;
	state.totalCacheRead += usage.cacheRead ?? 0;
	state.totalCacheWrite += usage.cacheWrite ?? 0;
	state.totalCost += usage.cost.total;
	if (extracted.isAssistant) {
		const promptTokens = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		state.latestCacheHitRate = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
	}
}

function canIncrement(prev: TokenState, entries: TokenEntry[], leafId: string | null): boolean {
	if (entries.length < prev.count) return false;
	if (prev.count > 0 && entries[prev.count - 1]?.id !== prev.lastEntryId) return false;
	if (prev.rootId !== undefined && entries.length > 0 && entries[0]?.id !== prev.rootId) return false;
	if (leafId !== prev.leafId && entries.length === prev.count) return false;
	return true;
}

let tokenState: TokenState | undefined;

function computeTokens(ctx: ExtensionContext): { state: TokenState; changed: boolean } {
	const entries = ctx.sessionManager.getEntries() as unknown as TokenEntry[];
	const leafId = (ctx.sessionManager as { getLeafId?: () => string | null }).getLeafId?.() ?? null;
	if (tokenState === undefined || !canIncrement(tokenState, entries, leafId)) {
		const fresh: TokenState = {
			count: entries.length,
			rootId: entries.length > 0 ? entries[0]?.id : undefined,
			lastEntryId: entries.length > 0 ? entries[entries.length - 1]?.id : undefined,
			leafId,
			totalInput: 0,
			totalOutput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			latestCacheHitRate: undefined,
		};
		for (const entry of entries) applyEntry(fresh, entry);
		tokenState = fresh;
		return { state: fresh, changed: true };
	}
	const prevCount = tokenState.count;
	for (let i = prevCount; i < entries.length; i++) applyEntry(tokenState, entries[i]);
	if (entries.length > 0) tokenState.lastEntryId = entries[entries.length - 1]?.id;
	tokenState.count = entries.length;
	tokenState.leafId = leafId;
	const changed = entries.length !== prevCount || leafId !== null;
	return { state: tokenState, changed };
}

// ---------------------------------------------------------------------------
// Git branch (fallback short-hash for detached HEAD, like pi-powerbar)
// ---------------------------------------------------------------------------

function readDetachedHash(cwd: string): string | undefined {
	let directory = cwd;
	try {
		while (true) {
			const dotGit = join(directory, ".git");
			let headPath: string | undefined;
			try {
				const stat = statSync(dotGit);
				if (stat.isDirectory()) headPath = join(dotGit, "HEAD");
				else {
					const pointer = readFileSync(dotGit, "utf-8").trim();
					if (pointer.startsWith("gitdir:")) headPath = join(directory, pointer.slice("gitdir:".length).trim(), "HEAD");
				}
			} catch {
				// keep walking up
			}
			if (headPath && existsSync(headPath)) {
				const head = readFileSync(headPath, "utf-8").trim();
				if (!head.startsWith("ref: refs/heads/")) return head.slice(0, 8);
				return undefined;
			}
			const parent = dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Rendering (ported verbatim from @juanibiapina/pi-powerbar, MIT)
// ---------------------------------------------------------------------------

function renderProgressBar(percent: number, width: number, theme: Theme, color: string): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filledFloat = (clamped / 100) * width;


	// Deviation from pi-powerbar: whole-cell glyphs only. The 1/8-width partial
	// glyphs (▏▎▍…) render narrower than a cell in many fonts, leaving a hairline
	// gap, and the transparent track was near-invisible on dim backgrounds.
	const filledCount = Math.round(filledFloat);
	const filled = "█".repeat(Math.min(filledCount, width));
	const trackCount = Math.max(0, width - filledCount);
	return theme.fg(color as ThemeColor, filled) + theme.fg("dim", "░".repeat(trackCount));
}

function fgToBgAnsi(fgAnsi: string): string {
	return fgAnsi.replace("\x1b[38;", "\x1b[48;");
}

function renderBlocksBar(percent: number, segments: number, theme: Theme, color: string): string {
	const glyphs = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const dimBg = fgToBgAnsi(theme.getFgAnsi("dim"));
	const fgColor = theme.getFgAnsi((color || "muted") as ThemeColor);
	const reset = "\x1b[39m\x1b[49m";
	const clamped = Math.max(0, Math.min(100, percent));
	const filledFloat = (clamped / 100) * segments;

	const result: string[] = [];
	for (let i = 0; i < segments; i++) {
		const blockFill = Math.max(0, Math.min(1, filledFloat - i));
		const level = Math.round(blockFill * 8);
		const glyph = glyphs[level];
		result.push(level > 0 ? `${dimBg}${fgColor}${glyph}${reset}` : `${dimBg}${glyph}${reset}`);
	}
	return result.join(" ");
}

function renderSegmentText(segment: Segment, settings: NativebarSettings, theme: Theme): string {
	const parts: string[] = [];
	const themeColor = (segment.color || "muted") as ThemeColor;

	if (segment.icon) parts.push(theme.fg(themeColor, segment.icon));
	if (segment.text) parts.push(theme.fg(themeColor, segment.text));

	if (segment.bar !== undefined) {
		const color = segment.color || "muted";
		if (settings.barStyle === "blocks") {
			const blockCount = segment.barSegments ?? settings.barWidth;
			parts.push(renderBlocksBar(segment.bar, blockCount, theme, color));
		} else {
			parts.push(renderProgressBar(segment.bar, settings.barWidth, theme, color));
		}
	}

	if (segment.suffix) parts.push(theme.fg(themeColor, segment.suffix));
	return parts.join(" ");
}

interface RenderedSegment {
	text: string;
	width: number;
}

function renderSideSegments(ids: string[], segments: Map<string, Segment>, settings: NativebarSettings, theme: Theme): RenderedSegment[] {
	const rendered: RenderedSegment[] = [];
	for (const id of ids) {
		const seg = segments.get(id);
		if (!seg || (!seg.text && !seg.suffix && seg.bar === undefined)) continue;
		const text = renderSegmentText(seg, settings, theme);
		rendered.push({ text, width: visibleWidth(text) });
	}
	return rendered;
}

function joinSegments(segments: RenderedSegment[], separator: string, separatorWidth: number): RenderedSegment {
	if (segments.length === 0) return { text: "", width: 0 };
	const text = segments.map((s) => s.text).join(separator);
	const width = segments.reduce((sum, s) => sum + s.width, 0) + separatorWidth * (segments.length - 1);
	return { text, width };
}

function shrinkWidest(segments: RenderedSegment[], overflow: number): void {
	if (segments.length === 0) return;
	let widestIdx = 0;
	for (let i = 1; i < segments.length; i++) {
		if (segments[i].width > segments[widestIdx].width) widestIdx = i;
	}
	const seg = segments[widestIdx];
	const targetWidth = Math.max(1, seg.width - overflow);
	segments[widestIdx] = { text: truncateToWidth(seg.text, targetWidth, "…"), width: targetWidth };
}

function renderBar(segments: Map<string, Segment>, settings: NativebarSettings, theme: Theme, width: number): string {
	const separator = theme.fg("dim", settings.separator);
	const separatorWidth = visibleWidth(separator);

	const leftSegs = renderSideSegments(settings.left, segments, settings, theme);
	const rightSegs = renderSideSegments(settings.right, segments, settings, theme);
	const allSegs = [...leftSegs, ...rightSegs];

	const leftSepCount = Math.max(0, leftSegs.length - 1);
	const rightSepCount = Math.max(0, rightSegs.length - 1);
	const totalSepWidth = (leftSepCount + rightSepCount) * separatorWidth;
	const totalSegWidth = allSegs.reduce((sum, s) => sum + s.width, 0);
	const minPadding = 1;
	const totalNeeded = totalSegWidth + totalSepWidth + minPadding;

	if (totalNeeded > width) {
		let overflow = totalNeeded - width;
		const maxPasses = allSegs.length;
		for (let i = 0; i < maxPasses && overflow > 0; i++) {
			shrinkWidest(allSegs, overflow);
			const newSegWidth = allSegs.reduce((sum, s) => sum + s.width, 0);
			overflow = newSegWidth + totalSepWidth + minPadding - width;
		}
	}

	const left = joinSegments(allSegs.slice(0, leftSegs.length), separator, separatorWidth);
	const right = joinSegments(allSegs.slice(leftSegs.length), separator, separatorWidth);

	const padding = Math.max(minPadding, width - left.width - right.width);
	const line = `${left.text}${" ".repeat(padding)}${right.text}`;
	return truncateToWidth(line, width, "…");
}

// ---------------------------------------------------------------------------
// Segment builders (native data)
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 100_000;

function contextColor(pct: number): string {
	if (pct > 80) return "error";
	if (pct > 60) return "warning";
	return "muted";
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function buildSegments(pi: ExtensionAPI, ctx: ExtensionContext | undefined, footerData: ReadonlyFooterData): Map<string, Segment> {
	const segments = new Map<string, Segment>();

	// 1) Event-fed segments (pi-powerbar protocol), so producer extensions keep working.
	for (const seg of overlaySegments.values()) {
		segments.set(seg.id, { ...seg });
	}

	if (!ctx) return segments;

	// 2) git-branch — native provider (or event overlay already provided one).
	if (!segments.has("git-branch")) {
		const branch = footerData.getGitBranch();
		if (branch) {
			segments.set("git-branch", {
				id: "git-branch",
				text: branch === "detached" ? (readDetachedHash(ctx.cwd) ?? "detached") : branch,
				icon: "⎇",
				color: "muted",
			});
		}
	}

	// 3) tokens — computed from session entries (same rules as pi's footer).
	if (!segments.has("tokens")) {
		const { state } = computeTokens(ctx);
		if (state.totalInput > 0 || state.totalOutput > 0) {
			const parts: string[] = [];
			parts.push(`↑${formatTokens(state.totalInput)}`);
			parts.push(`↓${formatTokens(state.totalOutput)}`);
			if (state.totalCacheRead > 0) parts.push(`R${formatTokens(state.totalCacheRead)}`);
			if (state.totalCacheWrite > 0) parts.push(`W${formatTokens(state.totalCacheWrite)}`);
			if ((state.totalCacheRead > 0 || state.totalCacheWrite > 0) && state.latestCacheHitRate !== undefined) {
				parts.push(`CH${state.latestCacheHitRate.toFixed(1)}%`);
			}
			if (state.totalCost > 0) parts.push(`$${state.totalCost.toFixed(2)}`);
			segments.set("tokens", { id: "tokens", text: parts.join(" "), color: "dim" });
		}
	}

	// 4) context-usage — native ctx.getContextUsage().
	if (!segments.has("context-usage")) {
		const usage = ctx.getContextUsage() as ContextEntry | undefined;
		if (usage && usage.tokens != null && usage.contextWindow > 0) {
			const pct = Math.round((usage.tokens / usage.contextWindow) * 100);
			segments.set("context-usage", {
				id: "context-usage",
				text: "",
				suffix: `${pct}%`,
				bar: pct,
				barSegments: Math.max(1, Math.ceil(usage.contextWindow / CHUNK_SIZE)),
				color: contextColor(pct),
			});
		}
	}

	// 5) provider + model — native ctx.model / thinking level.
	if (ctx.model) {
		const model = ctx.model;
		if (!segments.has("provider")) {
			segments.set("provider", { id: "provider", text: model.provider, color: "muted" });
		}
		if (!segments.has("model")) {
			let text = model.id;
			if (model.reasoning) {
				const level = pi.getThinkingLevel();
				text = level === "off" ? `${model.id} · off` : `${model.id} · ${level}`;
			}
			segments.set("model", { id: "model", text, color: "accent" });
		}
	}

	// 6) status — native extension status chips (pi-goal, background tasks, ...).
	if (!segments.has("status")) {
		const statuses = footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			const line = Array.from(statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.filter(Boolean)
				.join(" ");
			if (line) segments.set("status", { id: "status", text: line, color: "muted" });
		}
	}

	return segments;
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

const overlaySegments = new Map<string, Segment>();
const segmentCatalog = new Map<string, { id: string; label: string }>();
let latestCtx: ExtensionContext | undefined;
let settings: NativebarSettings;
let tuiRef: { requestRender(): void } | undefined;
let footerDataRef: ReadonlyFooterData | undefined;

export default function createExtension(pi: ExtensionAPI): void {
	settings = loadSettings(process.cwd());

	const requestRender = () => tuiRef?.requestRender();

	// Keep accepting pi-powerbar producer events (superset of the event protocol).
	pi.events.on("powerbar:update", (data: unknown) => {
		const payload = data as { id?: string; text?: string; suffix?: string; icon?: string; color?: string; bar?: number; barSegments?: number };
		if (!payload?.id) return;
		if (payload.text === undefined && payload.suffix === undefined && payload.bar === undefined) {
			if (overlaySegments.delete(payload.id)) requestRender();
			return;
		}
		overlaySegments.set(payload.id, {
			id: payload.id,
			text: payload.text ?? "",
			suffix: payload.suffix,
			icon: payload.icon,
			color: payload.color,
			bar: payload.bar,
			barSegments: payload.barSegments,
		});
		requestRender();
	});
	pi.events.on("powerbar:register-segment", (data: unknown) => {
		const { id, label } = data as { id: string; label?: string };
		segmentCatalog.set(id, { id, label: label ?? id });
	});

	// Register with pi-extension-settings when present (event, no import needed).
	// Local extensions load before npm packages, so pi-extension-settings' listener
	// Registers at load time only, exactly like pi-powerbar; this package must be
	// listed after @juanibiapina/pi-extension-settings in the packages array so the
	// listener already exists.
	function registerWithSettingsExtension(): void {
		pi.events.emit("pi-extension-settings:register", {
			name: EXTENSION_NAME,
			settings: [
			{
				id: "left",
				label: "Left segments",
				description: "Segments shown on the left side of the bar",
				defaultValue: DEFAULTS.left,
				options: [
					{ id: "git-branch", label: "Git Branch" },
					{ id: "tokens", label: "Tokens" },
					{ id: "context-usage", label: "Context Usage" },
					{ id: "provider", label: "Provider" },
					{ id: "model", label: "Model" },
					{ id: "status", label: "Extension Statuses" },
					{ id: "sub-hourly", label: "Sub Hourly (pi-usage)" },
					{ id: "sub-weekly", label: "Sub Weekly (pi-usage)" },
				],
			},
			{
				id: "right",
				label: "Right segments",
				description: "Segments shown on the right side of the bar",
				defaultValue: DEFAULTS.right,
				options: [
					{ id: "git-branch", label: "Git Branch" },
					{ id: "tokens", label: "Tokens" },
					{ id: "context-usage", label: "Context Usage" },
					{ id: "provider", label: "Provider" },
					{ id: "model", label: "Model" },
					{ id: "status", label: "Extension Statuses" },
					{ id: "sub-hourly", label: "Sub Hourly (pi-usage)" },
					{ id: "sub-weekly", label: "Sub Weekly (pi-usage)" },
				],
			},
			{
				id: "separator",
				label: "Separator",
				description: "Separator between segments",
				defaultValue: DEFAULTS.separator,
				values: [" │ ", " ┃ ", " | ", " · ", "  "],
			},
			{
				id: "placement",
				label: "Placement",
				description: "Where the bar appears",
				defaultValue: DEFAULTS.placement,
				values: ["belowEditor", "aboveEditor"],
			},
			{
				id: "bar-style",
				label: "Bar style",
				description: "Visual style of progress bars",
				defaultValue: DEFAULTS["bar-style"],
				values: ["continuous", "blocks"],
			},
			{
				id: "bar-width",
				label: "Bar width",
				description: "Width of progress bars in characters",
				defaultValue: DEFAULTS["bar-width"],
				values: ["6", "8", "10", "12", "16"],
			},
		],
		});
	}
	registerWithSettingsExtension();

	// Live settings: watch settings-extensions.json so /extension-settings edits and
	// manual file changes apply immediately (same approach as pi-powerbar).
	let settingsWatchCleanups: (() => void)[] = [];

	function stopWatchingSettings(): void {
		for (const stop of settingsWatchCleanups) stop();
		settingsWatchCleanups = [];
	}

	function reloadSettings(cwd: string): void {
		const nextSettings = loadSettings(cwd);
		if (JSON.stringify(nextSettings) === JSON.stringify(settings)) return;
		const placementChanged = nextSettings.placement !== settings.placement;
		settings = nextSettings;
		if (placementChanged && latestCtx) registerBar(latestCtx);
		requestRender();
	}

	/** Watch one settings file; returns a cleanup function (or undefined when unwatchable). */
	function watchSettingsFile(path: string, cwd: string): (() => void) | undefined {
		// Prefer native event-driven watching of the containing directory with a
		// short debounce (fs.watch is unsupported for files on some platforms).
		try {
			const dir = dirname(path);
			const name = basename(path);
			let debounceTimer: NodeJS.Timeout | undefined;
			const watcher = watch(dir, { persistent: false }, (_event, filename) => {
				if (filename !== name) return;
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => reloadSettings(cwd), 250);
			});
			return () => {
				if (debounceTimer) clearTimeout(debounceTimer);
				watcher.close();
			};
		} catch {
			// Native watching unavailable (unsupported filesystem): fall back to polling.
			watchFile(path, { interval: 1000, persistent: false }, () => reloadSettings(cwd));
			return () => unwatchFile(path);
		}
	}

	function startWatchingSettings(cwd: string): void {
		stopWatchingSettings();
		const paths = [
			join(getAgentDir(), SETTINGS_FILE_NAME),
			join(cwd, CONFIG_DIR_NAME, SETTINGS_FILE_NAME),
		];
		for (const path of paths) {
			const stop = watchSettingsFile(path, cwd);
			if (stop) settingsWatchCleanups.push(stop);
		}
	}
	function makeBarComponent(theme: Theme) {
		return {
			render(width: number): string[] {
				const segments = buildSegments(pi, latestCtx, footerDataRef ?? { getGitBranch: () => null, getExtensionStatuses: () => new Map() });
				return [renderBar(segments, settings, theme, width)];
			},
			invalidate(): void {},
		};
	}

	function registerBar(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (settings.placement === "belowEditor") {
			// Footer mode: the bar IS the footer; native statuses come from footerData.
			ctx.ui.setFooter((tui, theme, footerData) => {
				tuiRef = tui;
				footerDataRef = footerData;
				const component = makeBarComponent(theme);
				return {
					...component,
					dispose(): void {
						if (tuiRef === tui) tuiRef = undefined;
					},
				};
			});
		} else {
			// Widget mode (above editor): hide the native footer like pi-powerbar does.
			footerDataRef = footerDataRef ?? { getGitBranch: () => null, getExtensionStatuses: () => new Map() };
			ctx.ui.setFooter(() => ({ render(): string[] { return []; }, invalidate(): void {} }));
			ctx.ui.setWidget(
				EXTENSION_NAME,
				(tui, theme) => {
					tuiRef = tui;
					return makeBarComponent(theme);
				},
				{ placement: "aboveEditor" },
			);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		tokenState = undefined;
		settings = loadSettings(ctx.cwd);
		registerBar(ctx);
		if (ctx.hasUI) startWatchingSettings(ctx.cwd);
	});

	// Keep the latest context. The custom footer re-renders on every TUI render;
	// these events refresh the captured context so segments read live data.
	const onAny = pi.on.bind(pi) as unknown as (
		event: string,
		handler: (event: never, ctx: ExtensionContext) => Promise<void> | void,
	) => void;
	for (const event of [
		"turn_start",
		"turn_end",
		"tool_result",
		"session_compact",
		"session_tree",
		"model_select",
		"thinking_level_select",
		"agent_settled",
	]) {
		onAny(event, async (_event, ctx) => {
			latestCtx = ctx;
		});
	}

	pi.on("session_shutdown", async () => {
		stopWatchingSettings();
		latestCtx = undefined;
		tuiRef = undefined;
	});
}
