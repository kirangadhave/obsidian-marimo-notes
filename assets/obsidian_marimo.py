"""Access the Obsidian vault from marimo notebooks.

Provided by the obsidian-marimo plugin. Usage:

    from obsidian_marimo import vault

    text = await vault.read("some note.md")
    files = await vault.files()
    notes = await vault.notes()
"""

import asyncio
from typing import Any

import js
from pyodide.ffi import create_proxy, to_js
from pyodide.http import pyfetch


class _Unset:
    """Sentinel value to unset a frontmatter key."""

    def __repr__(self) -> str:
        return "vault.UNSET"


class VaultError(Exception):
    """Error from a vault operation."""

    def __init__(self, code: str, message: str) -> None:
        """Initialize VaultError.

        Args:
            code (str): Error code from the vault API.
            message (str): Human-readable error message.
        """
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


_UNSET = _Unset()


class Note:
    """A markdown note in the vault with its metadata."""

    def __init__(self, data: dict[str, Any], vault: "Vault") -> None:
        """Wrap one metadata entry.

        Args:
            data (dict): One note entry from the vault API.
            vault (Vault): The vault that answers delegated operations.
        """
        self._data = data
        self._vault = vault

    @property
    def path(self) -> str:
        """Vault path to this note."""
        return self._data["path"]

    @property
    def name(self) -> str:
        """Basename of this note, without extension."""
        return self._data["name"]

    @property
    def folder(self) -> str:
        """Parent folder path, or empty string at vault root."""
        return self._data["folder"]

    @property
    def size(self) -> int:
        """File size in bytes."""
        return self._data["size"]

    @property
    def ctime(self) -> int:
        """Creation time as milliseconds since epoch."""
        return self._data["ctime"]

    @property
    def mtime(self) -> int:
        """Last modification time as milliseconds since epoch."""
        return self._data["mtime"]

    @property
    def frontmatter(self) -> dict[str, Any]:
        """Frontmatter dictionary, or empty dict when absent."""
        return self._data["frontmatter"]

    @property
    def tags(self) -> list[str]:
        """List of tags, merged from inline and frontmatter."""
        return self._data["tags"]

    @property
    def headings(self) -> list[dict[str, Any]]:
        """List of headings, each with 'heading' (str) and 'level' (int)."""
        return self._data["headings"]

    @property
    def links(self) -> list[dict[str, Any]]:
        """List of links, each with 'link' (raw text) and 'target' (resolved path or null)."""
        return self._data["links"]

    @property
    def unresolved(self) -> list[str]:
        """Raw linktexts that did not resolve to a file."""
        return self._data["unresolved"]

    @property
    def tasks(self) -> list[dict[str, Any]]:
        """List of tasks, each with 'done' (bool) and 'line' (int)."""
        return self._data["tasks"]

    @property
    def blocks(self) -> list[str]:
        """List of block IDs in this note."""
        return self._data["blocks"]

    async def read(self) -> str:
        """Return the current text content of this note.

        Returns:
            The note text.

        Raises:
            VaultError: If the read fails.
        """
        return await self._vault.read(self.path)

    async def write(self, text: str) -> None:
        """Write text to this note.

        Args:
            text (str): The text to write.

        Raises:
            VaultError: If the write fails.
        """
        await self._vault.write(self.path, text)

    async def set_frontmatter(self, frontmatter: dict[str, Any]) -> None:
        """Merge frontmatter into this note.

        Args:
            frontmatter (dict): Key-value pairs to merge. Use vault.UNSET as a
                value to remove a key.

        Raises:
            VaultError: If the operation fails.
        """
        await self._vault.set_frontmatter(self.path, frontmatter)

    def __repr__(self) -> str:
        """Return a string representation."""
        return f"Note(path={self.path!r})"


class _VaultPort:
    """Port client for vault RPC over MessagePort."""

    def __init__(self) -> None:
        """Initialize port client and wait for port handshake."""
        self.port: Any = None
        self.next_id = 0
        self.pending: dict[int, asyncio.Future[Any]] = {}
        self._message_proxy: Any = None
        self._event_callback: Any = None

    async def _ensure_port(self, timeout: float = 2.0) -> None:
        """Wait for the plugin to publish the vault port.

        Args:
            timeout (float): Maximum number of seconds to wait.

        Raises:
            VaultError: If the port does not appear before the timeout.
        """
        if self.port is not None:
            return

        loop = asyncio.get_running_loop()
        start = loop.time()
        while True:
            try:
                self.port = js.__VAULT_PORT1__
                if self.port is not None:
                    self._attach_listener()
                    return
            except (AttributeError, TypeError):
                pass

            if loop.time() - start > timeout:
                raise VaultError(
                    "port_unavailable",
                    "Vault port not ready. The marimo islands plugin may be broken.",
                )

            await asyncio.sleep(0.05)

    def _attach_listener(self) -> None:
        """Attach a response listener to the port."""
        def on_message(event: Any) -> None:
            # The message crosses from JavaScript, so it arrives as a proxy
            # and not as a dict. to_py() converts it and every nested value.
            data_obj = event.data
            if not hasattr(data_obj, "to_py"):
                return
            data = data_obj.to_py()
            if not isinstance(data, dict):
                return

            # A push carries no id, because nothing answers it.
            if data.get("op") == "event" and "id" not in data:
                if self._event_callback is not None:
                    self._event_callback(data.get("events", []))
                return

            if not isinstance(data.get("id"), (int, float)):
                return
            future = self.pending.get(int(data["id"]))
            if future is not None and not future.done():
                future.set_result(data)

        # Keep a reference to the proxy so the garbage collector does not
        # destroy the callback while the port holds it.
        self._message_proxy = create_proxy(on_message)
        self.port.onmessage = self._message_proxy

    def set_event_callback(self, callback: Any) -> None:
        """Register a callback for event pushes from the plugin.

        Args:
            callback: A callable that receives a list of event dicts.
        """
        self._event_callback = callback

    async def _call(self, op: str, **kwargs: Any) -> Any:
        """Send a vault RPC request and wait for response.

        Args:
            op (str): Operation name.
            **kwargs: Operation arguments.

        Returns:
            The response value.

        Raises:
            VaultError: If the operation fails or times out.
        """
        await self._ensure_port()

        msg_id = self.next_id
        self.next_id += 1

        request = {"id": msg_id, "op": op, **kwargs}
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.pending[msg_id] = future

        try:
            # Convert Python dict to plain JS object so the dispatcher sees
            # the fields as properties, not as Map entries.
            self.port.postMessage(to_js(request, dict_converter=js.Object.fromEntries))
            response = await asyncio.wait_for(future, timeout=30.0)

            if response.get("ok"):
                return response.get("value")
            error = response.get("error", {})
            raise VaultError(
                error.get("code", "io_error"),
                error.get("message", "The vault operation failed."),
            )
        finally:
            self.pending.pop(msg_id, None)


async def _load_pandas() -> Any:
    """Import pandas, installing it into the kernel on first use.

    Returns:
        The pandas module.

    Raises:
        VaultError: If the install fails, which happens offline.
    """
    try:
        import pandas
    except ImportError:
        try:
            import micropip

            await micropip.install("pandas")
            import pandas
        except Exception as err:
            raise VaultError(
                "missing_dependency",
                f"pandas is not available and the install failed: {err}. "
                "Add `import pandas as pd` to a cell and reload the note, "
                "which makes marimo install it at startup.",
            ) from None
    return pandas


class Vault:
    """Reads and writes the vault this notebook lives in."""

    #: Assign this to a frontmatter key to remove it.
    UNSET = _UNSET

    def __init__(self) -> None:
        #: The vault root as an app:// URL.
        self.base: str = str(js.__VAULT_BASE__)
        self._port = _VaultPort()
        self._notes_cache: list[Note] | None = None
        self._notes_raw_cache: list[dict[str, Any]] | None = None
        self._links_cache: dict[str, Any] | None = None
        self._backlinks_cache: dict[str, list[str]] | None = None
        #: The most recent batch of events from the vault.
        self.last_events: list[dict[str, Any]] = []

        self._port.set_event_callback(self._on_vault_events)

    def _on_vault_events(self, events: list[dict[str, Any]]) -> None:
        """Drop every cache after the vault changes.

        Invalidation is global. Granular invalidation adds bookkeeping for no
        practical gain at this data size.

        Args:
            events (list[dict[str, Any]]): Each dict carries kind, path, and
                oldPath for a rename.
        """
        self.last_events = events
        self._notes_cache = None
        self._notes_raw_cache = None
        self._links_cache = None
        self._backlinks_cache = None

    async def read(self, path: str) -> str:
        """Return the current text content of a vault file."""
        resp = await pyfetch(f"{self.base}{path}?t={js.Date.now()}")
        return await resp.string()

    async def files(self, ext: str | None = None) -> list[dict[str, Any]]:
        """Query the vault's files.

        Args:
            ext (str | None, optional): Filter by file extension.
                A leading dot is optional. Both `.md` and `md` work.
                Comparison is case-insensitive. If not provided, all
                files in the vault are returned.

        Returns:
            A list of dicts, each with "path" (str), "ext" (str, file
            extension without leading dot), "size" (int), and "mtime"
            (int, milliseconds since epoch).

        Raises:
            VaultError: If the operation fails or the extension argument
                is invalid.
        """
        kwargs = {}
        if ext is not None:
            kwargs["ext"] = ext
        return await self._port._call("files", **kwargs)

    async def notes(
        self, folder: str | None = None, tag: str | None = None
    ) -> list[Note]:
        """Query the vault's markdown notes with metadata.

        Args:
            folder (str | None, optional): Filter by folder path prefix.
                A trailing slash is optional. Comparison is exact.
                If not provided, notes from all folders are returned.
            tag (str | None, optional): Filter by tag. A leading hash is
                optional. Comparison is case-insensitive, matching Obsidian
                behavior. If not provided, all notes are returned.

        Returns:
            A list of Note objects, sorted by path. Each Note wraps metadata
            from the vault cache: path, name, folder, size, ctime, mtime,
            frontmatter, tags, headings, links, unresolved, tasks, blocks.

        Raises:
            VaultError: If the operation fails or arguments are invalid.
        """
        kwargs = {}
        if folder is not None:
            kwargs["folder"] = folder
        if tag is not None:
            kwargs["tag"] = tag

        if not kwargs:
            if self._notes_cache is not None:
                return self._notes_cache

        response = await self._port._call("notes", **kwargs)
        notes = [Note(item, self) for item in response]

        if not kwargs:
            self._notes_raw_cache = response
            self._notes_cache = notes

        return notes

    async def links(self) -> dict[str, Any]:
        """Query the vault's forward link graph.

        Returns:
            A dict with keys "resolved" and "unresolved", each mapping a
            source path to a dict of destination path to link count. Resolved
            links point to existing vault files. Unresolved links point to
            names not found in the vault.

        Raises:
            VaultError: If the operation fails or times out.
        """
        if self._links_cache is not None:
            return self._links_cache

        response = await self._port._call("links")
        self._links_cache = response

        return response

    async def backlinks(self, path: str) -> list[str]:
        """Query the vault's backlink graph for a note.

        Args:
            path (str): Vault path to the note.

        Returns:
            A list of source paths that link to this path, sorted
            alphabetically. Only resolved links count, because an unresolved
            link points at no file.

        Raises:
            VaultError: If the operation fails or times out.
        """
        if self._backlinks_cache is None:
            links_graph = await self.links()
            self._backlinks_cache = {}

            for source, destinations in links_graph.get("resolved", {}).items():
                for dest in destinations:
                    self._backlinks_cache.setdefault(dest, []).append(source)

            for sources in self._backlinks_cache.values():
                sources.sort()

        return list(self._backlinks_cache.get(path, []))

    async def _raw_notes(self) -> list[dict[str, Any]]:
        """Return the cached note entries as the wire delivered them."""
        if self._notes_raw_cache is None:
            await self.notes()
        return self._notes_raw_cache or []

    async def read_bytes(self, path: str) -> bytes:
        """Return the current bytes content of a vault file.

        Args:
            path (str): Vault path to the file.

        Returns:
            The file's bytes content.

        Raises:
            VaultError: If the fetch fails or times out.
        """
        resp = await pyfetch(f"{self.base}{path}?t={js.Date.now()}")
        return await resp.bytes()

    async def read_many(self, paths: list[str]) -> list[str]:
        """Fetch multiple files concurrently.

        Args:
            paths (list[str]): Vault paths to read.

        Returns:
            A list of file texts in the order the paths were given.

        Raises:
            VaultError: If any fetch fails or times out.
        """
        return await asyncio.gather(*[self.read(path) for path in paths])

    async def tasks(
        self, done: bool | None = None
    ) -> list[dict[str, Any]]:
        """Query every checkbox in the vault.

        Args:
            done (bool | None, optional): Filter by completion state.
                True returns only finished tasks, False returns only open tasks,
                and None returns all tasks. Default is None.

        Returns:
            A list of dicts, each with "path" (str), "done" (bool), and "line"
            (int). Sorted by path, then by line.

        Raises:
            VaultError: If the notes query fails.
        """
        notes = await self.notes()
        result = []
        for note in notes:
            for task in note.tasks:
                if done is None or task["done"] == done:
                    result.append(
                        {"path": note.path, "done": task["done"], "line": task["line"]}
                    )
        result.sort(key=lambda t: (t["path"], t["line"]))
        return result

    async def self_note(self) -> Note:
        """Return the note that hosts this notebook.

        Returns:
            A Note object for the hosting note.

        Raises:
            VaultError: If the notebook is not attached to a note.
        """
        response = await self._port._call("self")
        return Note(response, self)

    async def frontmatter(self, path: str) -> dict[str, Any]:
        """Read the frontmatter of one note.

        Args:
            path (str): Vault path to the note.

        Returns:
            The frontmatter dict, or empty dict if absent.

        Raises:
            VaultError: If the path is not a note in the vault (code: not_found).
        """
        notes = await self.notes()
        for note in notes:
            if note.path == path:
                return note.frontmatter
        raise VaultError("not_found", f"Note not found: {path}")

    async def write(self, path: str, data: str | bytes) -> None:
        """Write a file to the vault.

        Args:
            path (str): Vault path to write to.
            data (str | bytes): File content. Strings are written as-is. Bytes
                are written as binary.

        Raises:
            VaultError: If the write fails or the path is invalid.
        """
        # Bytes cross as a typed array, which structured clone moves without
        # a copy into base64 and back.
        wire_data = to_js(data) if isinstance(data, bytes) else data

        await self._port._call("write", path=path, data=wire_data)

    async def exists(self, path: str) -> bool:
        """Check if a file exists in the vault.

        Args:
            path (str): Vault path to check.

        Returns:
            True if the file exists, False otherwise.

        Raises:
            VaultError: If the operation fails.
        """
        return await self._port._call("exists", path=path)

    async def append(self, path: str, text: str) -> None:
        """Append text to a file in the vault.

        Creates the file when it is missing. Appends accumulate in arrival
        order and never coalesce, so no appended data is lost.

        Args:
            path (str): Vault path to append to.
            text (str): The text to append.

        Raises:
            VaultError: If the operation fails or the path is invalid.
        """
        await self._port._call("append", path=path, data=text)

    async def trash(self, path: str) -> None:
        """Move a file to trash.

        Respects the user's "Deleted files" setting. The API never hard-deletes.

        Args:
            path (str): Vault path to trash.

        Raises:
            VaultError: If the operation fails or the file is not found.
        """
        await self._port._call("trash", path=path)

    async def set_frontmatter(self, path: str, frontmatter: dict[str, Any]) -> None:
        """Merge frontmatter into a note.

        Merges the given key-value pairs into the note's frontmatter. Keys not
        mentioned are untouched. Use vault.UNSET as a value to remove a key.
        The file must exist.

        Args:
            path (str): Vault path to the note.
            frontmatter (dict): Key-value pairs to merge. A value of
                vault.UNSET removes that key.

        Raises:
            VaultError: If the operation fails, the file is not found, or
                the path is invalid.

        Example:
            ```python
            await vault.set_frontmatter(
                "areas/reading.md",
                {"status": "done", "due": vault.UNSET, "note": None},
            )
            ```
        """
        # The sentinel never crosses the wire. Splitting it into a list of
        # key names keeps user data from colliding with a magic value.
        data = {}
        unset = []
        for key, value in frontmatter.items():
            if value is _UNSET:
                unset.append(key)
            else:
                data[key] = value

        await self._port._call("set_frontmatter", path=path, data=data, unset=unset)

    async def frame(self) -> Any:
        """Return all notes as a pandas DataFrame.

        Frontmatter keys become columns prefixed with "fm_", so a key named
        path or tags cannot collide with a built-in column. The built-in
        columns are path, name, folder, size, ctime, mtime, tags, headings,
        links, unresolved, tasks, and blocks.

        Pyodide does not preload pandas, and marimo installs only the
        packages it finds in the notebook source. This module reaches the
        kernel as an exec'd string, so that scan never sees the import here.
        The first call therefore installs pandas itself, which takes several
        seconds. A notebook that never asks for a frame never pays for it.

        Returns:
            A DataFrame with one row per note.

        Raises:
            VaultError: If pandas is missing and the install fails, with code
                missing_dependency.
        """
        pd = await _load_pandas()

        raw_entries = await self._raw_notes()

        rows = []
        frontmatter_keys = set()

        for entry in raw_entries:
            for key in entry.get("frontmatter", {}).keys():
                frontmatter_keys.add(key)

        for entry in raw_entries:
            row = {
                "path": entry["path"],
                "name": entry["name"],
                "folder": entry["folder"],
                "size": entry["size"],
                "ctime": entry["ctime"],
                "mtime": entry["mtime"],
                "tags": entry["tags"],
                "headings": entry["headings"],
                "links": entry["links"],
                "unresolved": entry["unresolved"],
                "tasks": entry["tasks"],
                "blocks": entry["blocks"],
            }

            for key in frontmatter_keys:
                row[f"fm_{key}"] = entry.get("frontmatter", {}).get(key)

            rows.append(row)

        return pd.DataFrame(rows)

    # The documented call is vault.self(). A method named self would shadow
    # the instance parameter inside its own body, so the alias carries the
    # name and self_note carries the definition.
    self = self_note


vault = Vault()
