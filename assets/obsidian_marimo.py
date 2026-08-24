"""Access the Obsidian vault from marimo notebooks.

Provided by the obsidian-marimo plugin. Usage:

    from obsidian_marimo import vault

    text = await vault.read("some note.md")
    files = await vault.files()
"""

import asyncio
from typing import Any

import js
from pyodide.ffi import create_proxy, to_js
from pyodide.http import pyfetch


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


class _VaultPort:
    """Port client for vault RPC over MessagePort."""

    def __init__(self) -> None:
        """Initialize port client and wait for port handshake."""
        self.port: Any = None
        self.next_id = 0
        self.pending: dict[int, asyncio.Future[Any]] = {}
        self._message_proxy: Any = None

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
            if not isinstance(data, dict) or not isinstance(
                data.get("id"), (int, float)
            ):
                return
            future = self.pending.get(int(data["id"]))
            if future is not None and not future.done():
                future.set_result(data)

        # Keep a reference to the proxy so the garbage collector does not
        # destroy the callback while the port holds it.
        self._message_proxy = create_proxy(on_message)
        self.port.onmessage = self._message_proxy

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


class Vault:
    """Reads files from the vault this notebook lives in."""

    def __init__(self) -> None:
        #: The vault root as an app:// URL.
        self.base: str = str(js.__VAULT_BASE__)
        self._port = _VaultPort()

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


vault = Vault()
