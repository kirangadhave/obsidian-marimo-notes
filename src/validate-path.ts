/**
 * The security boundary for vault writes.
 *
 * A notebook author controls the Python kernel completely, so any cell can
 * skip the helper module and post to the port directly. Every request is
 * therefore hostile until this file says otherwise. Checks on the Python
 * side produce friendly errors and protect nothing.
 */

import { normalizePath, TAbstractFile, TFolder } from "obsidian";
import { VaultRpcError } from "./vault-rpc";

const ALLOWED_EXTENSIONS = [
	"md",
	"csv",
	"json",
	"txt",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"parquet",
];

export interface PathValidatorHost {
	/** Taken from `app.vault.configDir`, which the user can rename. */
	configDir: string;
	getAbstractFileByPath(path: string): TAbstractFile | null;
	/** Reports whether the target stays inside the vault after symlinks resolve. */
	checkSymlinkContainment(path: string): boolean;
}

/**
 * Returns the normalized vault path, or throws with the code that names the
 * reason. A caller must use the returned value and never the input, because
 * normalization changes the string.
 */
export function validatePath(path: unknown, host: PathValidatorHost): string {
	if (typeof path !== "string" || path === "") {
		throw new VaultRpcError("invalid_path", "The path must be a non-empty string.");
	}

	// A null byte truncates the name in some filesystem calls, so the file
	// that opens is not the file that was checked.
	if (path.includes("\0")) {
		throw new VaultRpcError("invalid_path", "The path must not contain a null byte.");
	}

	// Normalization strips a leading separator, so an absolute path has to be
	// rejected while it is still recognizable.
	if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) {
		throw new VaultRpcError("invalid_path", "The path must be relative to the vault.");
	}

	const p = normalizePath(path);

	// Segments are tested after normalization on purpose. Normalization turns
	// a backslash into a separator, so "a\\..\\escape.md" only shows its
	// parent reference once it is normalized. A substring test would be wrong
	// in the other direction, because "..foo.md" is a legitimate file name.
	if (p.split("/").some((segment) => segment === "..")) {
		throw new VaultRpcError(
			"invalid_path",
			"The path must not walk out of its folder.",
		);
	}

	// A write under the config directory stays inside the vault and is still
	// full code execution on the next reload, because it reaches installed
	// plugins and community-plugins.json. The comparison ignores case,
	// because the filesystem does on macOS and Windows.
	const configDir = normalizePath(host.configDir).toLowerCase();
	const lower = p.toLowerCase();
	if (lower === configDir || lower.startsWith(configDir + "/")) {
		throw new VaultRpcError(
			"denied_config_dir",
			"The vault configuration directory is not writable.",
		);
	}

	// The extension comes from the last segment. A dot in a folder name says
	// nothing about the file type.
	const name = p.slice(p.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (!ALLOWED_EXTENSIONS.includes(ext)) {
		throw new VaultRpcError(
			"denied_extension",
			`Writes are limited to these file types: ${ALLOWED_EXTENSIONS.join(", ")}.`,
		);
	}

	// A symlinked folder inside the vault is a door out of it. Without this
	// check a notebook writes anywhere the user account can reach, while
	// every path above still looks like an ordinary vault path.
	if (!host.checkSymlinkContainment(p)) {
		throw new VaultRpcError(
			"denied_symlink",
			"Writes through symlinked folders are not allowed.",
		);
	}

	if (host.getAbstractFileByPath(p) instanceof TFolder) {
		throw new VaultRpcError("invalid_path", "The path names a folder.");
	}

	return p;
}
