import {
	getAllTags,
	MarkdownPostProcessorContext,
	Notice,
	Plugin,
	requestUrl,
	TFile,
} from "obsidian";
import marimoLogo from "../assets/marimo-logo.png";
import obsidianPy from "../assets/obsidian_marimo.py";
import { MARIMO_MD_FENCE, marimoFenceField } from "./live-preview";
import {
	VaultRpc,
	type LinkGraph,
	type NoteEntry,
	type VaultEvent,
	type VaultRpcHost,
} from "./vault-rpc";

/**
 * Pin the islands runtime to a marimo release. The runtime resolves its own
 * matching marimo wheel + Pyodide at this version, so bumping this constant
 * upgrades the whole stack.
 */
const ISLANDS_VERSION = "0.24.0";
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@marimo-team/islands@${ISLANDS_VERSION}/dist`;

interface IslandsRuntime {
	initialize(): Promise<void>;
	stopApp(appId?: string): Promise<void>;
}

// esbuild outputs CJS, which rewrites `import()` to `require()`. Route the
// dynamic import through Function so it stays a native ESM import at runtime.
const dynamicImport = new Function(
	"url",
	"return import(url)",
) as (url: string) => Promise<IslandsRuntime>;

/** Obsidian's legacy CodeMirror mode registry (used for fence highlighting). */
interface CodeMirrorLike {
	defineMode?: (name: string, factory: (config: unknown) => unknown) => void;
	getMode?: (config: unknown, spec: unknown) => unknown;
}

/**
 * Injected into every notebook as a hidden bootstrap cell. Registers the
 * `obsidian_marimo` module (source shipped in assets/obsidian_marimo.py,
 * delivered via the __OBSIDIAN_PY__ worker global) so user cells write an
 * explicit, ordinary `from obsidian_marimo import vault`. All names here are
 * underscore-prefixed — cell-private in marimo — so the cell adds nothing to
 * the notebook namespace and cannot collide with user code.
 */
const VAULT_BOOTSTRAP_CODE = `import sys as _sys
import types as _types
import js as _js

if "obsidian_marimo" not in _sys.modules:
    _mod = _types.ModuleType("obsidian_marimo")
    exec(str(_js.__OBSIDIAN_PY__), _mod.__dict__)
    _sys.modules["obsidian_marimo"] = _mod`;

export default class MarimoPlugin extends Plugin {
	private runtime: Promise<IslandsRuntime> | null = null;
	private styleEl: HTMLElement | null = null;
	private initTimer: number | null = null;
	private bootstrapContainer: HTMLElement | null = null;
	private workerPatched = false;
	private initializedCells = new Set<string>();
	private cellIndexMap = new Map<string, number[]>();
	private workerGlobals = "";
	private bootStage = 0;
	private bootStageTs = Date.now();
	private bootError: string | null = null;
	private vaultRpc: VaultRpc | null = null;
	private metadataCacheResolved: Promise<void> | null = null;
	private appIdToPath = new Map<string, string>();

	async onload() {
		this.metadataCacheResolved = this.waitForMetadataCacheResolved();
		this.watchVaultEvents();

		// Both fence flavors — ```marimo and ```python {.marimo} — share one
		// pipeline: this post-processor in reading view, the editor extension
		// below in live preview. No code-block processor: registering one
		// would make Obsidian wrap ```marimo fences in its own embed widget,
		// a second widget system with its own edit chrome.
		this.registerMarkdownPostProcessor((el, ctx) => {
			this.upgradeMarimoBlocks(el, ctx);
		});

		// The same flavor in live preview, where fences render as editor
		// text and the post-processor above never runs.
		this.registerEditorExtension(marimoFenceField(this));

		// Refresh loader texts (catches the slow-first-boot hint in stage 1)
		// and keep marimo widget shadow roots free of Obsidian's stylesheet.
		this.registerInterval(
			window.setInterval(() => {
				this.updateLoaderTexts();
				this.scrubShadowStyles(document);
			}, 2000),
		);

		// Syntax-highlight ```marimo fences as Python in the editor. Obsidian
		// resolves fence languages through its CodeMirror mode registry.
		const cm = (window as { CodeMirror?: CodeMirrorLike }).CodeMirror;
		const getMode = cm?.getMode;
		if (cm?.defineMode && getMode) {
			cm.defineMode("marimo", (config) => getMode(config, "python"));
		}

		// View-mode switches don't re-render blocks — Obsidian keeps both the
		// live-preview and reading DOMs and toggles which is displayed. Re-run
		// initialization so reactivity follows the visible copy (a cheap
		// rebind, not a kernel restart, when code is unchanged).
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleInitialize()),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.scheduleInitialize(),
			),
		);

		this.addCommand({
			id: "reinitialize",
			name: "Reinitialize notebooks in open notes",
			callback: () => {
				this.initializedCells.clear();
				void this.initializeIslands();
			},
		});

	}

	onunload() {
		this.styleEl?.remove();
		if (this.initTimer !== null) {
			window.clearTimeout(this.initTimer);
		}
	}

	/** Builds the <marimo-island> DOM the islands runtime discovers on init. */
	private renderIsland(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	) {
		this.buildIsland(el, source, ctx.sourcePath);
	}

	/** Shared island construction for reading view and live preview. */
	buildIsland(el: HTMLElement, source: string, sourcePath: string) {
		const code = source.trim();
		if (!code) {
			return;
		}

		const wrapper = el.createDiv({ cls: "marimo-island-block" });
		// marimo's stylesheet keys dark mode off a Tailwind-style `.dark`
		// ancestor; mirror Obsidian's theme onto the island container.
		wrapper.classList.toggle("dark", document.body.hasClass("theme-dark"));

		// Built via innerHTML on purpose: once the runtime has defined the
		// marimo-island custom element, document.createElement() would run its
		// constructor and throw ("the result must not have attributes") —
		// parser-created elements take the upgrade path, which is allowed.
		// All cells from the same note share one app id, i.e. one reactive
		// notebook: a slider in one block reruns dependent blocks below it.
		const appId = appIdForPath(sourcePath);
		this.appIdToPath.set(appId, sourcePath);
		wrapper.innerHTML = islandHtml(
			appId,
			code,
			this.loaderText(),
		);
		this.scheduleInitialize();
	}

	/**
	 * Finds default-rendered marimo blocks and swaps them for islands.
	 * A ```marimo fence is recognizable by its language class alone. For
	 * ```python {.marimo}, the attribute lives in the fence info string,
	 * which Obsidian drops during rendering, so it is re-read from the
	 * section source. Plain python blocks are untouched.
	 */
	private upgradeMarimoBlocks(
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	) {
		const codeBlocks = Array.from(
			el.querySelectorAll<HTMLElement>(
				"pre > code.language-marimo, pre > code.language-python",
			),
		);
		for (const codeBlock of codeBlocks) {
			if (codeBlock.classList.contains("language-python")) {
				const section = ctx.getSectionInfo(codeBlock);
				if (!section) {
					continue;
				}
				const fenceLine =
					section.text.split("\n")[section.lineStart] ?? "";
				if (!MARIMO_MD_FENCE.test(fenceLine.trim())) {
					continue;
				}
			}
			const pre = codeBlock.parentElement;
			if (!pre?.parentElement) {
				continue;
			}
			const host = document.createElement("div");
			pre.replaceWith(host);
			this.renderIsland(codeBlock.textContent ?? "", host, ctx);
		}
	}

	/**
	 * Debounced so every block in a note is in the DOM before the runtime
	 * snapshots the page into a notebook.
	 */
	private scheduleInitialize() {
		if (this.initTimer !== null) {
			window.clearTimeout(this.initTimer);
		}
		this.initTimer = window.setTimeout(() => {
			this.initTimer = null;
			void this.initializeIslands();
		}, 400);
	}

	/**
	 * Every runtime.initialize() call restarts the Python session, so calling
	 * it on each render loops the kernel boot forever. Only (re)initialize
	 * when the set of cells actually changed since the last initialization.
	 */
	private async initializeIslands() {
		this.markVisibleIslandsReactive();
		this.ensureBootstrapIslands();
		this.tryRebindIslands();
		if (this.isCurrentDomInitialized()) {
			this.snapshotCellIndexes();
			return;
		}
		this.restoreConsumedIslands();
		try {
			const runtime = await this.loadRuntime();
			// The runtime auto-initializes on module load; loadRuntime records
			// the cell set it saw. Skip if the DOM hasn't changed since.
			if (this.isCurrentDomInitialized()) {
				this.snapshotCellIndexes();
				return;
			}
			this.initializedCells = new Set(this.cellEntries());
			await runtime.initialize();
			this.snapshotCellIndexes();
		} catch (error) {
			console.error("[marimo] failed to initialize islands", error);
			this.runtime = null;
			this.initializedCells.clear();
			new Notice(
				"marimo: failed to load the notebook runtime. Are you online?",
			);
		}
	}

	/**
	 * Obsidian keeps the live-preview and reading-view DOMs alive at once,
	 * each holding a copy of every island. marimo's Pyodide runtime is a
	 * singleton per interpreter, so the duplicate cells must not all join the
	 * app (duplicate definitions error, and two concurrent apps crash with
	 * "RuntimeContext was already initialized"). The inactive view is
	 * display:none (offsetParent === null); make only visible islands
	 * reactive — the parser ignores non-reactive ones.
	 */
	private markVisibleIslandsReactive() {
		for (const el of this.allIslands()) {
			if (this.isBootstrapIsland(el)) {
				continue; // handled by ensureBootstrapIslands
			}
			el.setAttribute("data-reactive", String(el.offsetParent !== null));
		}
	}

	/**
	 * Every app gets one hidden cell defining the `vault` helper (see
	 * VAULT_BOOTSTRAP_CODE). The islands live in a plugin-owned hidden
	 * container; they are reactive exactly when their app has visible cells,
	 * and are removed when the app's islands are gone entirely.
	 */
	private ensureBootstrapIslands() {
		if (!this.bootstrapContainer) {
			// First element in <body>: the runtime assigns cell indexes in
			// document order, and independent cells run in index order, so
			// the module registration runs before any user cell imports it.
			this.bootstrapContainer = createDiv({
				cls: "marimo-bootstrap-container",
			});
			document.body.insertBefore(
				this.bootstrapContainer,
				document.body.firstChild,
			);
			this.register(() => this.bootstrapContainer?.remove());
		}
		const container = this.bootstrapContainer;

		const visibleApps = new Set<string>();
		const allApps = new Set<string>();
		for (const el of this.allIslands()) {
			if (this.isBootstrapIsland(el)) {
				continue;
			}
			const appId = el.getAttribute("data-app-id");
			if (!appId) {
				continue;
			}
			allApps.add(appId);
			if (el.getAttribute("data-reactive") === "true") {
				visibleApps.add(appId);
			}
		}

		for (const el of Array.from(container.children)) {
			const appId = el.getAttribute("data-app-id") ?? "";
			if (!allApps.has(appId)) {
				el.remove();
			} else {
				el.setAttribute("data-reactive", String(visibleApps.has(appId)));
			}
		}
		for (const appId of visibleApps) {
			if (!container.querySelector(`[data-app-id="${appId}"]`)) {
				const host = document.createElement("div");
				host.innerHTML = islandHtml(appId, VAULT_BOOTSTRAP_CODE, "");
				const island = host.firstElementChild as HTMLElement;
				island.setAttribute("data-reactive", "true");
				container.appendChild(island);
			}
		}
	}

	private isBootstrapIsland(el: HTMLElement): boolean {
		return this.bootstrapContainer?.contains(el) ?? false;
	}

	/**
	 * True when the runtime already covers the current DOM:
	 * - every reactive island carries the data-cell-idx binding the runtime
	 *   stamps during discovery (live preview recreates widget DOM with
	 *   identical content; fresh elements are unbound and need a re-init), and
	 * - the reactive cell set is a SUBSET of the initialized set. Subset, not
	 *   equality: opening a block's editor removes its island from the DOM,
	 *   and rebuilding the notebook without that cell breaks its dependents
	 *   (NameError) only to rebuild again seconds later. A vanished cell keeps
	 *   its definitions in the running kernel, which is the better transient.
	 */
	private isCurrentDomInitialized(): boolean {
		const islands = this.reactiveIslands();
		if (islands.some((el) => !el.hasAttribute("data-cell-idx"))) {
			return false;
		}
		return this.cellEntries().every((e) => this.initializedCells.has(e));
	}

	/** Identity of the reactive cells: app id + cell code. */
	private cellEntries(): string[] {
		return this.reactiveIslands().map(
			(el) =>
				`${el.getAttribute("data-app-id")}:${el.getAttribute("data-mo-code") ?? ""}`,
		);
	}

	/**
	 * Remembers which notebook cell index each (app id, code) pair was bound
	 * to, in DOM order — duplicates get successive indexes.
	 */
	private snapshotCellIndexes() {
		this.cellIndexMap.clear();
		for (const el of this.reactiveIslands()) {
			const idx = el.getAttribute("data-cell-idx");
			if (idx === null) {
				continue;
			}
			const entry = `${el.getAttribute("data-app-id")}:${el.getAttribute("data-mo-code") ?? ""}`;
			const idxs = this.cellIndexMap.get(entry) ?? [];
			idxs.push(Number(idx));
			this.cellIndexMap.set(entry, idxs);
		}
	}

	/**
	 * Rebinds recreated island elements to their existing notebook cells
	 * without restarting the kernel. Obsidian recreates block DOM constantly
	 * (edit toggle, view switch, scroll); as long as the code is unchanged,
	 * the cell still lives in the running notebook — stamp the remembered
	 * data-cell-idx and fire the runtime's source-changed event, and the
	 * custom element re-renders the cell's current output from the store.
	 */
	private tryRebindIslands() {
		if (!customElements.get("marimo-island")) {
			return; // runtime not booted yet — nothing to rebind to
		}
		const seen = new Map<string, number>();
		for (const el of this.reactiveIslands()) {
			const entry = `${el.getAttribute("data-app-id")}:${el.getAttribute("data-mo-code") ?? ""}`;
			const position = seen.get(entry) ?? 0;
			seen.set(entry, position + 1);
			if (el.hasAttribute("data-cell-idx")) {
				continue;
			}
			const idxs = this.cellIndexMap.get(entry);
			if (!idxs || position >= idxs.length) {
				continue; // new or edited cell — needs a real initialization
			}
			el.setAttribute("data-cell-idx", String(idxs[position]));
			el.dispatchEvent(new Event("marimo-island-source-changed"));
		}
	}

	/**
	 * Once the runtime binds an island, its React rendering replaces the
	 * original <marimo-cell-output>/<marimo-cell-code> children — the parser
	 * then sees "missing cell output or code" and drops the cell, so any later
	 * re-initialization builds a partial (or empty) notebook. Before re-init,
	 * rebuild consumed islands from the code retained in data-mo-code.
	 * replaceWith cleanly unmounts the old element's React root via its
	 * disconnectedCallback.
	 */
	private restoreConsumedIslands() {
		for (const el of this.allIslands()) {
			const appId = el.getAttribute("data-app-id");
			const code = el.getAttribute("data-mo-code");
			if (!appId || !code || el.querySelector("marimo-cell-code")) {
				continue;
			}
			const host = el.ownerDocument.createElement("div");
			host.innerHTML = islandHtml(
				appId,
				decodeURIComponent(code),
				this.loaderText(),
			);
			const fresh = host.firstElementChild as HTMLElement;
			fresh.setAttribute(
				"data-reactive",
				el.getAttribute("data-reactive") ?? "false",
			);
			el.replaceWith(fresh);
		}
	}

	/**
	 * marimo copies same-origin stylesheets into each widget's shadow root —
	 * and in Obsidian, the app's own app.css IS same-origin (app://obsidian.md),
	 * so Obsidian's unlayered `button { … }` etc. rules land inside every
	 * widget and beat marimo's layered Tailwind utilities (icon buttons become
	 * gray pills). Remove any adopted sheet that contains Obsidian-specific
	 * selectors. Runs on an interval because widgets mount continuously.
	 */
	private scrubShadowStyles(root: Document | ShadowRoot) {
		const els = root.querySelectorAll<HTMLElement>("*");
		for (const el of Array.from(els)) {
			if (!el.tagName.startsWith("MARIMO-") || !el.shadowRoot) {
				continue;
			}
			const sr = el.shadowRoot;
			for (const sheet of sr.adoptedStyleSheets) {
				// Empty it in place: marimo caches and reuses this copied
				// sheet object for every future widget, so one wipe covers
				// them all. (It is marimo's copy — Obsidian's real stylesheet
				// is untouched.)
				if (isObsidianSheet(sheet)) {
					sheet.replaceSync("");
				}
			}
			this.scrubShadowStyles(sr);
		}
	}

	private allIslands(): HTMLElement[] {
		return Array.from(document.querySelectorAll<HTMLElement>("marimo-island"));
	}

	private reactiveIslands(): HTMLElement[] {
		return this.allIslands().filter(
			(el) => el.getAttribute("data-reactive") === "true",
		);
	}

	private getLiveAppId(): string | null {
		const appIds = new Set<string>();
		for (const el of this.reactiveIslands()) {
			if (this.isBootstrapIsland(el)) {
				continue;
			}
			const appId = el.getAttribute("data-app-id");
			if (appId) {
				appIds.add(appId);
			}
		}
		if (appIds.size === 1) {
			return Array.from(appIds)[0];
		}
		return null;
	}

	/** Loads the islands runtime + stylesheet once per session. */
	private loadRuntime(): Promise<IslandsRuntime> {
		if (!this.runtime) {
			this.patchWorkerForPyodide();
			this.runtime = (async () => {
				const source = await this.resolveRuntimeSource();
				this.injectStyles(source.css);
				// The module auto-initializes with the DOM as of this import;
				// record it so initializeIslands doesn't double-start.
				this.initializedCells = new Set(this.cellEntries());
				return dynamicImport(source.mainUrl);
			})();
		}
		return this.runtime;
	}

	/**
	 * Prefers the runtime vendored into the plugin dir (scripts/
	 * vendor-islands.sh), served via Obsidian's app:// resource URLs; falls
	 * back to jsDelivr when vendor/ is absent. Pyodide and Python wheels are
	 * fetched by the runtime itself either way.
	 */
	private async resolveRuntimeSource(): Promise<{
		mainUrl: string;
		css: string;
	}> {
		const adapter = this.app.vault.adapter;
		const vendorDir = `${this.manifest.dir}/vendor/islands`;

		// Vault root as an app:// URL, so notebook Python can read vault
		// files: pyfetch(str(js.__VAULT_BASE__) + "path/in/vault.csv").
		const manifestSuffix = `${this.manifest.dir}/manifest.json`;
		const manifestUrl = adapter
			.getResourcePath(manifestSuffix)
			.split("?")[0];
		if (manifestUrl.endsWith(manifestSuffix)) {
			this.workerGlobals = `globalThis.__VAULT_BASE__=${JSON.stringify(
				manifestUrl.slice(0, -manifestSuffix.length),
			)};`;
		}
		// Source of the `obsidian_marimo` Python module (see VAULT_BOOTSTRAP_CODE).
		this.workerGlobals += `globalThis.__OBSIDIAN_PY__=${JSON.stringify(obsidianPy)};`;

		// Vendored Pyodide (scripts/vendor-pyodide.sh): point the patched
		// worker chunk at the local mirror via globals the shim injects.
		const lockPath = `${this.manifest.dir}/vendor/pyodide/pyodide-lock.json`;
		if (await adapter.exists(lockPath)) {
			const lockUrl = adapter.getResourcePath(lockPath).split("?")[0];
			this.workerGlobals +=
				`globalThis.__MARIMO_LOCK__=${JSON.stringify(lockUrl)};` +
				`globalThis.__PYODIDE_BASE__=${JSON.stringify(
					lockUrl.replace(/pyodide-lock\.json$/, ""),
				)};`;
		}

		if (await adapter.exists(`${vendorDir}/main.js`)) {
			return {
				mainUrl: adapter.getResourcePath(`${vendorDir}/main.js`),
				css: await adapter.read(`${vendorDir}/style.css`),
			};
		}
		console.info("[marimo] no vendored runtime, falling back to CDN");
		const res = await requestUrl(`${CDN_BASE}/style.css`);
		return { mainUrl: `${CDN_BASE}/main.js`, css: res.text };
	}

	/**
	 * Obsidian's CSP only allows 'self' and inline styles, so a CDN <link>
	 * is refused. Inject the stylesheet text inline instead.
	 */
	private injectStyles(css: string) {
		if (this.styleEl) {
			return;
		}
		// The title is load-bearing: marimo copies document stylesheets into
		// each widget's shadow root, but only sheets titled "marimo*" (or with
		// an @marimo-team href, which an inline style lacks). Untitled, every
		// widget renders unstyled — e.g. sliders collapse to nothing.
		this.styleEl = document.head.createEl("style", {
			attr: { title: "marimo-islands" },
			text: css,
		});
	}

	/** Current loader message, derived from the observed boot stage. */
	private loaderText(): string {
		if (this.bootError) {
			return this.bootError;
		}
		if (this.bootStage === 1 && Date.now() - this.bootStageTs > 20_000) {
			return "Downloading Python runtime — first run can take a minute…";
		}
		return BOOT_STAGES[this.bootStage];
	}

	private updateLoaderTexts() {
		const text = this.loaderText();
		const els = document.querySelectorAll(".marimo-loading-text");
		for (const el of Array.from(els)) {
			if (el.textContent !== text) {
				el.textContent = text;
			}
		}
	}

	/** Advance-only; each stage is triggered by a real boot signal. */
	private setBootStage(stage: number) {
		if (stage <= this.bootStage) {
			return;
		}
		this.bootStage = stage;
		this.bootStageTs = Date.now();
		this.updateLoaderTexts();
	}

	/** Observes worker messages to claim the vault RPC port and advance the boot stage. */
	private onWorkerMessage(data: unknown) {
		if (
			data &&
			typeof data === "object" &&
			"op" in data &&
			data.op === "__vault_port" &&
			"port" in data &&
			data.port instanceof MessagePort
		) {
			const host: VaultRpcHost = {
				getFiles: () =>
					this.app.vault.getFiles().map((f) => ({
						path: f.path,
						ext: f.extension,
						size: f.stat.size,
						mtime: f.stat.mtime,
					})),
				getNotes: async (folder?: string, tag?: string) =>
					await this.buildNotes(folder, tag),
				getLinks: async () => await this.buildLinks(),
				getSelf: async () => await this.getSelfNote(),
			};
			this.vaultRpc = new VaultRpc(data.port, host);
			return;
		}

		if (this.bootStage >= 3 && !this.bootError) {
			return;
		}
		let text = "";
		try {
			text = JSON.stringify(data) ?? "";
		} catch {
			return;
		}
		if (text.includes("initializedError")) {
			this.bootError = "marimo failed to start — see developer console";
			this.updateLoaderTexts();
		} else if (text.includes("kernel-ready")) {
			this.setBootStage(3);
		} else if (text.includes("initialized")) {
			this.setBootStage(2);
		}
	}

	/**
	 * Obsidian enables Node integration in Web Workers, so `process` exists in
	 * worker scope. Pyodide's environment detection then picks its Node.js code
	 * path, which is dead in marimo's bundle (fs/path are stubbed out), and the
	 * kernel silently never boots. Wrap the islands runtime's worker bootstrap
	 * (a blob that ESM-imports the real worker module) to hide `process` before
	 * the module evaluates, so Pyodide detects a browser worker.
	 */
	private patchWorkerForPyodide() {
		if (this.workerPatched) {
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;
		const NativeWorker = window.Worker;
		const PatchedWorker = function (
			url: string | URL,
			opts?: WorkerOptions,
		): Worker {
			let target = url;
			let isMarimoWorker = false;
			try {
				if (
					typeof url === "string" &&
					url.startsWith("blob:") &&
					opts?.type === "module"
				) {
					const xhr = new XMLHttpRequest();
					xhr.open("GET", url, false);
					xhr.send();
					const match = xhr.responseText.match(
						/^\s*import\s*"((?:https?|app):[^"]+)"\s*;?\s*$/,
					);
					if (match && /marimo|islands/.test(match[1])) {
						// Both imports MUST be static: the worker only queues
						// incoming messages until its initial evaluation ends,
						// and the page sends its one-shot consumerReady
						// handshake immediately. A dynamic import() finishes
						// evaluation instantly and the handshake is lost. The
						// data: module evaluates first, hiding process before
						// Pyodide's environment detection runs.
						const prelude =
							"try{delete globalThis.process}catch(e){}" +
							"globalThis.process=undefined;" +
							plugin.workerGlobals +
							// A dedicated channel for vault traffic, so it
							// never shares marimo's own RPC channel. Python
							// reaches port1 through the worker global; port2
							// is transferred to the page, which is the only
							// way a port crosses a worker boundary.
							"(function(){" +
							"var c=new MessageChannel();" +
							"globalThis.__VAULT_PORT1__=c.port1;" +
							"globalThis.postMessage({op:'__vault_port',port:c.port2},[c.port2]);" +
							"})();";
						const shim = [
							`import ${JSON.stringify(
								`data:text/javascript;charset=utf-8,${encodeURIComponent(prelude)}`,
							)};`,
							`import ${JSON.stringify(match[1])};`,
						].join("\n");
						target = URL.createObjectURL(
							new Blob([shim], { type: "application/javascript" }),
						);
						isMarimoWorker = true;
					}
				}
			} catch (error) {
				console.warn("[marimo] worker shim failed, using original", error);
			}
			const worker = new NativeWorker(target, opts);
			if (isMarimoWorker) {
				plugin.setBootStage(1);
				worker.addEventListener("message", (ev) =>
					plugin.onWorkerMessage(ev.data),
				);
			}
			return worker;
		} as unknown as typeof Worker;
		PatchedWorker.prototype = NativeWorker.prototype;
		window.Worker = PatchedWorker;
		this.register(() => {
			window.Worker = NativeWorker;
		});
		this.workerPatched = true;
	}

	private isCacheResolved(): boolean {
		const files = this.app.vault.getMarkdownFiles();
		const resolved = this.app.metadataCache.resolvedLinks;
		return files.every((f) => f.path in resolved);
	}

	private async waitForMetadataCacheResolved(): Promise<void> {
		if (this.isCacheResolved()) {
			return;
		}

		return new Promise<void>((resolve) => {
			let timer = 0;
			const eventRef = this.app.metadataCache.on("resolved", () => {
				if (this.isCacheResolved()) {
					this.app.metadataCache.offref(eventRef);
					window.clearTimeout(timer);
					resolve();
				}
			});

			// An answer from a half-built cache beats a call that never
			// returns, so give up waiting rather than block the notebook.
			timer = window.setTimeout(() => {
				this.app.metadataCache.offref(eventRef);
				console.warn(
					"[marimo] metadata cache did not resolve in time, answering anyway",
				);
				resolve();
			}, 30_000);
		});
	}

	private buildNoteEntry(file: TFile): NoteEntry {
		const cache = this.app.metadataCache.getFileCache(file);

		const allTags = cache ? (getAllTags(cache) || []) : [];

		let frontmatter: Record<string, unknown> = {};
		if (cache?.frontmatter) {
			try {
				frontmatter = JSON.parse(JSON.stringify(cache.frontmatter));
			} catch {
				// User frontmatter can be arbitrary YAML with cyclic values.
			}
		}

		const headings = (cache?.headings || []).map((h) => ({
			heading: h.heading,
			level: h.level,
		}));

		const linksArray: Array<{ link: string; target: string | null }> = [];
		const unresolvedSet = new Set<string>();

		if (cache) {
			const allLinks = [
				...(cache.links || []),
				...(cache.embeds || []),
				...(cache.frontmatterLinks || []),
			];

			for (const linkItem of allLinks) {
				const linkText = linkItem.link.split(/[#^]/)[0];

				if (!linkText) {
					continue;
				}

				const target = this.app.metadataCache.getFirstLinkpathDest(
					linkText,
					file.path,
				);

				linksArray.push({
					link: linkItem.link,
					target: target ? target.path : null,
				});

				if (!target) {
					unresolvedSet.add(linkItem.link);
				}
			}
		}

		const tasks: Array<{ done: boolean; line: number }> = [];
		if (cache?.listItems) {
			for (const item of cache.listItems) {
				if (item.task !== undefined) {
					tasks.push({
						done: item.task !== " ",
						line: item.position.start.line,
					});
				}
			}
		}

		const blocks = cache?.blocks
			? Object.keys(cache.blocks)
			: [];

		const parent = file.parent?.path ?? "";
		const parentFolder = parent === "/" ? "" : parent;

		return {
			path: file.path,
			name: file.basename,
			folder: parentFolder,
			size: file.stat.size,
			ctime: file.stat.ctime,
			mtime: file.stat.mtime,
			frontmatter,
			tags: allTags,
			headings,
			links: linksArray,
			unresolved: Array.from(unresolvedSet),
			tasks,
			blocks,
		};
	}

	private async buildNotes(folder?: string, tag?: string): Promise<NoteEntry[]> {
		await this.metadataCacheResolved;

		const notes: NoteEntry[] = [];

		const files = this.app.vault.getMarkdownFiles();
		const normalizedFolder = folder ? folder.replace(/\/$/, "") : "";
		const normalizedTag = tag ? tag.replace(/^#/, "").toLowerCase() : "";

		for (const file of files) {
			if (normalizedFolder) {
				if (!file.path.startsWith(normalizedFolder + "/") &&
					file.path !== normalizedFolder) {
					continue;
				}
			}

			const entry = this.buildNoteEntry(file);
			if (normalizedTag) {
				const has = entry.tags.some(
					(t) => t.replace(/^#/, "").toLowerCase() === normalizedTag,
				);
				if (!has) {
					continue;
				}
			}

			notes.push(entry);
		}

		return notes.sort((a, b) => a.path.localeCompare(b.path));
	}

	private async buildLinks(): Promise<LinkGraph> {
		await this.metadataCacheResolved;

		const resolved: Record<string, Record<string, number>> = {};
		const unresolved: Record<string, Record<string, number>> = {};

		for (const [source, links] of Object.entries(
			this.app.metadataCache.resolvedLinks,
		)) {
			resolved[source] = { ...links };
		}

		for (const [source, links] of Object.entries(
			this.app.metadataCache.unresolvedLinks,
		)) {
			unresolved[source] = { ...links };
		}

		return { resolved, unresolved };
	}

	private async getSelfNote(): Promise<NoteEntry | null> {
		await this.metadataCacheResolved;

		const liveAppId = this.getLiveAppId();
		if (liveAppId === null) {
			return null;
		}

		const sourcePath = this.appIdToPath.get(liveAppId);
		if (!sourcePath) {
			return null;
		}

		const file = this.app.vault.getFileByPath(sourcePath);
		if (!file) {
			return null;
		}

		return this.buildNoteEntry(file);
	}

	/**
	 * Feeds vault changes to the notebook so its cached metadata does not go
	 * stale. Watching starts only once the layout is ready, because the
	 * initial vault scan would otherwise report every file as a creation.
	 */
	private watchVaultEvents(): void {
		const record = (
			kind: VaultEvent["kind"],
			path: string,
			oldPath?: string,
		) => this.vaultRpc?.recordEvent(kind, path, oldPath);

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					record("create", file.path);
				}),
			);

			this.registerEvent(
				this.app.vault.on("modify", (file) => {
					record("modify", file.path);
				}),
			);

			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					record("delete", file.path);
				}),
			);

			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					record("rename", file.path, oldPath);
				}),
			);

			this.registerEvent(
				this.app.metadataCache.on("changed", (file) => {
					record("modify", file.path);
				}),
			);
		});
	}
}

/**
 * The islands DOM contract, plus data-mo-code: a plugin-owned copy of the
 * cell source that survives the runtime consuming the child elements.
 * data-reactive starts false; markVisibleIslandsReactive() enables exactly
 * one view's copy before each runtime initialization. encodeURIComponent
 * output is HTML-safe.
 */
function islandHtml(
	appId: string,
	code: string,
	loadingText: string,
): string {
	const encoded = encodeURIComponent(code);
	return (
		`<marimo-island data-app-id="${appId}" data-reactive="false" data-mo-code="${encoded}">` +
		`<marimo-cell-output>${loadingHtml(loadingText)}</marimo-cell-output>` +
		`<marimo-cell-code hidden>${encoded}</marimo-cell-code>` +
		`</marimo-island>`
	);
}

/**
 * Boot stages, advanced by real signals — not timers:
 * 0 at render, 1 when the Pyodide worker is created, 2 on the worker's
 * "initialized" message (Python + marimo installed), 3 on kernel-ready.
 */
const BOOT_STAGES = [
	"Loading marimo…",
	"Loading Python runtime…",
	"Starting notebook…",
	"Running cells…",
];

function loadingHtml(text: string): string {
	return (
		`<div class="marimo-island-loading">` +
		`<img class="marimo-loading-logo" src="${marimoLogo}" alt="" />` +
		`<div class="marimo-loading-body">` +
		`<span class="marimo-loading-text">${text}</span>` +
		`<div class="marimo-loading-bar"><div class="marimo-loading-bar-fill"></div></div>` +
		`</div></div>`
	);
}

const sheetVerdicts = new WeakMap<CSSStyleSheet, boolean>();

/** Detects Obsidian's app stylesheet by its unmistakable selectors. */
function isObsidianSheet(sheet: CSSStyleSheet): boolean {
	const cached = sheetVerdicts.get(sheet);
	if (cached !== undefined) {
		return cached;
	}
	let verdict = false;
	try {
		// Full scan: Obsidian's app.css opens with thousands of generic
		// variable rules before any .workspace selector appears. Runs once
		// per sheet object (cached below).
		const rules = sheet.cssRules;
		for (let i = 0; i < rules.length; i++) {
			const text = (rules[i] as CSSStyleRule).selectorText ?? "";
			if (text.includes(".workspace") || text.includes(".theme-dark")) {
				verdict = true;
				break;
			}
		}
	} catch {
		verdict = false;
	}
	sheetVerdicts.set(sheet, verdict);
	return verdict;
}

function appIdForPath(path: string): string {
	let hash = 0;
	for (let i = 0; i < path.length; i++) {
		hash = (hash * 31 + path.charCodeAt(i)) | 0;
	}
	return `note-${(hash >>> 0).toString(36)}`;
}
