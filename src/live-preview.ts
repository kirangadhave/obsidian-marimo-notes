import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, setIcon } from "obsidian";

/** Matches marimo's markdown notebook fences: ```python {.marimo ...} */
export const MARIMO_MD_FENCE = /^(?:`{3,}|~{3,})\s*\{?python[\s.,]+[^}]*marimo/i;

/** Matches the plugin's own shorthand fences: ```marimo */
const MARIMO_PLAIN_FENCE = /^(?:`{3,}|~{3,})\s*\{?\.?marimo\b/i;

/** ```marimo is syntactic sugar for ```python {.marimo}. */
export function isMarimoFenceLine(line: string): boolean {
	return MARIMO_PLAIN_FENCE.test(line) || MARIMO_MD_FENCE.test(line);
}

/**
 * The one capability the extension needs from the plugin: build island DOM
 * into a host element (same path as reading view and ```marimo blocks).
 */
export interface IslandHost {
	buildIsland(el: HTMLElement, code: string, sourcePath: string): void;
}

interface Fence {
	from: number;
	to: number;
	code: string;
}

/**
 * Live preview draws code fences as CodeMirror text, so the reading-view
 * post-processor never sees ```python {.marimo} blocks there. This state
 * field replaces those fences with island widgets while the cursor is
 * outside them. Plain python fences are not touched. Block widgets must
 * come from a state field, not a view plugin — CodeMirror forbids
 * layout-changing decorations from plugins.
 */
export function marimoFenceField(host: IslandHost): Extension {
	return StateField.define<DecorationSet>({
		create: (state) => buildDecorations(state, host),
		update: (deco: DecorationSet, tr: Transaction) => {
			const modeChanged =
				tr.startState.field(editorLivePreviewField) !==
				tr.state.field(editorLivePreviewField);
			if (tr.docChanged || tr.selection || modeChanged) {
				return buildDecorations(tr.state, host);
			}
			return deco.map(tr.changes);
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

function buildDecorations(
	state: EditorState,
	host: IslandHost,
): DecorationSet {
	if (!state.field(editorLivePreviewField)) {
		return Decoration.none;
	}
	const path = state.field(editorInfoField).file?.path ?? "";
	const builder = new RangeSetBuilder<Decoration>();
	for (const fence of marimoFences(state)) {
		if (!fence.code.trim() || selectionTouches(state, fence)) {
			continue;
		}
		builder.add(
			fence.from,
			fence.to,
			Decoration.replace({
				widget: new IslandWidget(host, fence.code, path),
				block: true,
			}),
		);
	}
	return builder.finish();
}

/**
 * Line scan instead of the syntax tree: fence begin/end node names are an
 * Obsidian internal, while the fence grammar (CommonMark: a closing fence
 * uses the same character, at least as long as the opener) is stable. Every
 * fence is skipped as a unit so fence-like content inside one cannot open
 * a phantom block. An unclosed fence ends the scan — the note is mid-edit.
 */
function marimoFences(state: EditorState): Fence[] {
	const doc = state.doc;
	const fences: Fence[] = [];
	let lineNo = 1;
	while (lineNo <= doc.lines) {
		const line = doc.line(lineNo);
		const open = line.text.match(/^(`{3,}|~{3,})/);
		if (!open) {
			lineNo++;
			continue;
		}
		const marker = open[1];
		const closeRe = new RegExp(`^\\${marker[0]}{${marker.length},}\\s*$`);
		let closeNo = -1;
		for (let j = lineNo + 1; j <= doc.lines; j++) {
			if (closeRe.test(doc.line(j).text)) {
				closeNo = j;
				break;
			}
		}
		if (closeNo === -1) {
			break;
		}
		if (isMarimoFenceLine(line.text.trim())) {
			const code =
				closeNo > lineNo + 1
					? doc.sliceString(
							doc.line(lineNo + 1).from,
							doc.line(closeNo - 1).to,
						)
					: "";
			fences.push({ from: line.from, to: doc.line(closeNo).to, code });
		}
		lineNo = closeNo + 1;
	}
	return fences;
}

/**
 * Parses marimo fences from raw file content, using the same grammar as the
 * CodeMirror path. Preserves file order and duplicates. Used to extract fences
 * from the active file's source, ensuring the cell set equals the fences
 * regardless of what is visible in the DOM.
 */
export function parseMarimoFences(content: string): string[] {
	const lines = content.split("\n");
	const codes: string[] = [];
	let lineNo = 0;
	while (lineNo < lines.length) {
		const line = lines[lineNo];
		const open = line.match(/^(`{3,}|~{3,})/);
		if (!open) {
			lineNo++;
			continue;
		}
		const marker = open[1];
		const closeRe = new RegExp(`^\\${marker[0]}{${marker.length},}\\s*$`);
		let closeNo = -1;
		for (let j = lineNo + 1; j < lines.length; j++) {
			if (closeRe.test(lines[j])) {
				closeNo = j;
				break;
			}
		}
		if (closeNo === -1) {
			break;
		}
		if (isMarimoFenceLine(line.trim())) {
			const code =
				closeNo > lineNo + 1
					? lines.slice(lineNo + 1, closeNo).join("\n")
					: "";
			codes.push(code);
		}
		lineNo = closeNo + 1;
	}
	return codes;
}

function selectionTouches(state: EditorState, fence: Fence): boolean {
	return state.selection.ranges.some(
		(range) => range.from <= fence.to && range.to >= fence.from,
	);
}

class IslandWidget extends WidgetType {
	constructor(
		private readonly host: IslandHost,
		private readonly code: string,
		private readonly path: string,
	) {
		super();
	}

	eq(other: IslandWidget): boolean {
		return other.code === this.code && other.path === this.path;
	}

	toDOM(view: EditorView): HTMLElement {
		const container = document.body.createEl("div", {
			cls: "marimo-lp-block",
		});
		this.host.buildIsland(container, this.code, this.path);
		// Anchor the edit affordance inside the island card so CodeMirror's
		// contain:paint on the widget cannot clip it at the card border.
		const card =
			container.querySelector<HTMLElement>(".marimo-island-block") ??
			container;
		const edit = card.createEl("button", {
			cls: "marimo-lp-edit",
			attr: { "aria-label": "Edit this block", type: "button" },
		});
		// Same icon as Obsidian's native edit button on ```marimo widgets;
		// icon ids vary across the lucide versions Obsidian bundles.
		setIcon(edit, "code-2");
		if (!edit.firstChild) {
			setIcon(edit, "code");
		}
		edit.addEventListener("click", (event) => {
			event.preventDefault();
			const pos = view.posAtDOM(container);
			view.dispatch({ selection: { anchor: pos } });
			view.focus();
		});
		return container;
	}

	/** Keep clicks and drags inside the island (sliders, inputs) out of CM. */
	ignoreEvent(): boolean {
		return true;
	}
}
