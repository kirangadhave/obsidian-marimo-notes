/**
 * Vault RPC dispatcher for requests from Python over MessagePort.
 * Handles request/response protocol with structured error codes.
 */

export type ErrorCode =
	| "unknown_op"
	| "invalid_path"
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

export class VaultRpc {
	private port: MessagePort;

	constructor(port: MessagePort) {
		this.port = port;
		this.port.onmessage = (ev) => this.handleRequest(ev.data);
		this.port.start();
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

	private async dispatchOp(op: string, _request: Request): Promise<unknown> {
		if (op === "ping") {
			return "pong";
		}

		throw new VaultRpcError("unknown_op", `Unknown operation: ${op}`);
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
