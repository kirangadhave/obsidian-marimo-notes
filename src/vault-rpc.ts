/**
 * Vault RPC dispatcher for requests from Python over MessagePort.
 */

import { TAbstractFile } from "obsidian";
import { validatePath } from "./validate-path";

export interface NoteEntry {
	path: string;
	name: string;
	folder: string;
	size: number;
	ctime: number;
	mtime: number;
	frontmatter: Record<string, unknown>;
	tags: string[];
	headings: Array<{ heading: string; level: number }>;
	links: Array<{ link: string; target: string | null }>;
	unresolved: string[];
	tasks: Array<{ done: boolean; line: number }>;
	blocks: string[];
}

export type ErrorCode =
	| "unknown_op"
	| "invalid_path"
	| "invalid_arg"
	| "denied_config_dir"
	| "denied_extension"
	| "denied_self_write"
	| "denied_symlink"
	| "not_found"
	| "io_error";

interface Request {
	id: number;
	op: string;
	[key: string]: unknown;
}

interface SuccessResponse {
	id: number;
	ok: true;
	value: unknown;
}

interface ErrorResponse {
	id: number;
	ok: false;
	error: {
		code: ErrorCode;
		message: string;
	};
}

type Response = SuccessResponse | ErrorResponse;

/**
 * Narrow interface that declares only the capabilities the vault RPC
 * dispatcher needs from the host. Isolates the protocol from the broader
 * plugin interface.
 */
/**
 * The forward link graph. Each map goes from a source path to a map of
 * destination to link count.
 */
export interface LinkGraph {
	resolved: Record<string, Record<string, number>>;
	unresolved: Record<string, Record<string, number>>;
}

export interface VaultRpcHost {
	getFiles(): Array<{ path: string; ext: string; size: number; mtime: number }>;
	getNotes(folder?: string, tag?: string): Promise<NoteEntry[]>;
	getLinks(): Promise<LinkGraph>;
	getSelf(): Promise<NoteEntry | null>;
	getConfigDir(): string;
	getAbstractFileByPath(path: string): TAbstractFile | null;
	checkSymlinkContainment(path: string): boolean;
}

/** One vault change, as the plugin observed it. */
export interface VaultEvent {
	kind: "create" | "modify" | "delete" | "rename";
	path: string;
	oldPath?: string;
}

export class VaultRpc {
	private port: MessagePort;
	private host: VaultRpcHost;
	private eventBatch: VaultEvent[] = [];
	private eventTimer: number | null = null;
	private eventPathIndex = new Map<string, number>();

	constructor(port: MessagePort, host: VaultRpcHost) {
		this.port = port;
		this.host = host;
		this.port.onmessage = (ev) => this.handleRequest(ev.data);
		this.port.start();
	}

	/**
	 * Records one vault change for the next push. Obsidian fires modify on
	 * every autosave, so the batch window below is the storm control.
	 */
	recordEvent(kind: VaultEvent["kind"], path: string, oldPath?: string): void {
		const event: VaultEvent = { kind, path };
		if (oldPath !== undefined) {
			event.oldPath = oldPath;
		}

		const existingIndex = this.eventPathIndex.get(path);
		if (existingIndex !== undefined) {
			this.eventBatch[existingIndex] = event;
		} else {
			this.eventPathIndex.set(path, this.eventBatch.length);
			this.eventBatch.push(event);
		}

		this.schedulePush();
	}

	/**
	 * The first change opens a fixed window rather than restarting a timer,
	 * so a steady stream of edits still reaches the notebook on time.
	 */
	private schedulePush(): void {
		if (this.eventTimer !== null) {
			return;
		}

		this.eventTimer = window.setTimeout(() => {
			this.eventTimer = null;
			this.flushEvents();
		}, 500);
	}

	private flushEvents(): void {
		if (this.eventBatch.length === 0) {
			return;
		}

		const events = this.eventBatch;
		this.eventBatch = [];
		this.eventPathIndex.clear();

		// No id: nothing answers this message.
		this.port.postMessage({ op: "event", events });
	}

	private async handleRequest(data: unknown): Promise<void> {
		if (!this.isValidRequest(data)) {
			return;
		}

		const request = data as Request;

		try {
			const value = await this.dispatchOp(request.op, request);
			this.sendResponse({
				id: request.id,
				ok: true,
				value,
			});
		} catch (error) {
			const { code, message } = this.errorToResponse(error);
			this.sendResponse({
				id: request.id,
				ok: false,
				error: { code, message },
			});
		}
	}

	private isValidRequest(data: unknown): boolean {
		if (!data || typeof data !== "object") {
			return false;
		}
		const obj = data as Record<string, unknown>;
		return (
			typeof obj.id === "number" &&
			typeof obj.op === "string"
		);
	}

	private async dispatchOp(op: string, request: Request): Promise<unknown> {
		if (op === "ping") {
			return "pong";
		}

		if (op === "files") {
			return this.opFiles(request);
		}

		if (op === "notes") {
			return await this.opNotes(request);
		}

		if (op === "links") {
			return await this.host.getLinks();
		}

		if (op === "self") {
			return await this.opSelf();
		}

		throw new VaultRpcError("unknown_op", `Unknown operation: ${op}`);
	}

	private opFiles(request: Request): unknown {
		const ext = request.ext;

		if (
			ext !== undefined &&
			ext !== null &&
			typeof ext !== "string"
		) {
			throw new VaultRpcError("invalid_arg", "ext must be a string");
		}

		const files = this.host.getFiles();

		if (!ext) {
			return files;
		}

		// Obsidian stores the extension without a dot, but a caller writes
		// either form.
		const wanted = ext.replace(/^\./, "").toLowerCase();

		return files.filter((f) => f.ext.toLowerCase() === wanted);
	}

	private async opNotes(request: Request): Promise<unknown> {
		const folder = request.folder;
		const tag = request.tag;

		if (
			folder !== undefined &&
			folder !== null &&
			typeof folder !== "string"
		) {
			throw new VaultRpcError("invalid_arg", "folder must be a string");
		}

		if (
			tag !== undefined &&
			tag !== null &&
			typeof tag !== "string"
		) {
			throw new VaultRpcError("invalid_arg", "tag must be a string");
		}

		return await this.host.getNotes(folder || undefined, tag || undefined);
	}

	private async opSelf(): Promise<unknown> {
		const entry = await this.host.getSelf();
		if (entry === null) {
			throw new VaultRpcError(
				"not_found",
				"The notebook is not attached to a note",
			);
		}
		return entry;
	}

	/** Every write-class operation takes its path from here, never raw. */
	private validateRequestPath(request: Request): string {
		return validatePath(request.path, {
			configDir: this.host.getConfigDir(),
			getAbstractFileByPath: (p) => this.host.getAbstractFileByPath(p),
			checkSymlinkContainment: (p) => this.host.checkSymlinkContainment(p),
		});
	}

	private sendResponse(response: Response): void {
		this.port.postMessage(response);
	}

	private errorToResponse(error: unknown): { code: ErrorCode; message: string } {
		if (error instanceof VaultRpcError) {
			return { code: error.code, message: error.message };
		}
		if (error instanceof Error) {
			return { code: "io_error", message: error.message };
		}
		return { code: "io_error", message: String(error) };
	}
}

export class VaultRpcError extends Error {
	constructor(public code: ErrorCode, message: string) {
		super(message);
		this.name = "VaultRpcError";
	}
}
