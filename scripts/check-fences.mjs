import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

function getPython3() {
	try {
		execSync("which python3", { stdio: "pipe" });
		return "python3";
	} catch {
		console.error("error: python3 not found in PATH");
		process.exit(1);
	}
}

function walkMarkdown(dir) {
	const files = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkMarkdown(fullPath));
		} else if (entry.name.endsWith(".md")) {
			files.push(fullPath);
		}
	}
	return files;
}

// Require closing fence on its own line to avoid matching backticks in code.
function extractFences(content) {
	const fences = [];
	const fencePattern = /```marimo\n([\s\S]*?)\n```/g;
	let match;
	let fenceIndex = 0;
	while ((match = fencePattern.exec(content)) !== null) {
		fences.push({
			fenceIndex,
			source: match[1],
		});
		fenceIndex++;
	}
	return fences;
}

function buildSyntaxChecker() {
	return `
import ast
import sys
import json

data = json.load(sys.stdin)
errors = []

for item in data:
	path = item["path"]
	fence_idx = item["fenceIndex"]
	source = item["source"]
	try:
		# Top-level await is legal in marimo cells.
		compile(source, f"{path}:fence{fence_idx}", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
	except SyntaxError as e:
		errors.append(f"{path}: fence {fence_idx}: {e.msg}")

if errors:
	for err in errors:
		print(err)
	sys.exit(1)
else:
	total_fences = len(data)
	note_count = len(set(item["path"] for item in data))
	print(f"checked {total_fences} fences in {note_count} notes")
`.trim();
}

const vaultDir = "examples/demo-vault";
const files = walkMarkdown(vaultDir);

if (files.length === 0) {
	console.error(`error: no markdown files found in ${vaultDir}`);
	process.exit(1);
}

const allFences = [];
for (const filePath of files) {
	const content = readFileSync(filePath, "utf8");
	const fences = extractFences(content);
	const relPath = relative(vaultDir, filePath);
	for (const fence of fences) {
		allFences.push({
			path: relPath,
			fenceIndex: fence.fenceIndex,
			source: fence.source,
		});
	}
}

if (allFences.length === 0) {
	console.log("checked 0 fences in 0 notes");
	process.exit(0);
}

const python3 = getPython3();
const checkerCode = buildSyntaxChecker();
const input = JSON.stringify(allFences);

try {
	const output = execSync(`${python3} -c "${checkerCode.replace(/"/g, '\\"')}"`, {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	process.stdout.write(output);
} catch (error) {
	if (error.stdout) {
		process.stdout.write(error.stdout);
	}
	if (error.stderr) {
		process.stderr.write(error.stderr);
	}
	process.exit(error.status || 1);
}
