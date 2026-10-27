#!/usr/bin/env python3
"""leo-status relay: TCP forwarder for the VPS side of the hub tunnel.

Topology (see leo-status/CONTRACT-V2.md §1):

    Caddy (container, hostname caddy)
        |  http://172.18.0.1:18888/...
        v
    this process  (listens on the docker bridge gateway only)
        |
        v
    127.0.0.1:18899  (SSH reverse tunnel opened by the leo-status DSH plugin)
        |
        v
    the hub machine's 127.0.0.1:8790

Only python3 stdlib is used. The listener is deliberately bound to the docker
bridge gateway address, not 0.0.0.0: containers on the docker network can reach
it, while the public interface cannot. Remembering that this process never
speaks HTTP itself - it only pipes bytes - is the point: when the hub/tunnel is
down every request must *fail to forward* instead of being answered locally.

Defaults can be overridden for testing with the environment variables
LEO_RELAY_LISTEN_HOST / LEO_RELAY_LISTEN_PORT / LEO_RELAY_TARGET_HOST /
LEO_RELAY_TARGET_PORT.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

LISTEN_HOST = os.environ.get("LEO_RELAY_LISTEN_HOST", "172.18.0.1")
LISTEN_PORT = int(os.environ.get("LEO_RELAY_LISTEN_PORT", "18888"))
TARGET_HOST = os.environ.get("LEO_RELAY_TARGET_HOST", "127.0.0.1")
TARGET_PORT = int(os.environ.get("LEO_RELAY_TARGET_PORT", "18899"))
CONNECT_TIMEOUT = 5.0
BUFFER_SIZE = 64 * 1024

log = logging.getLogger("leo-status-relay")


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Copy reader -> writer until EOF, then half-close (write_eof) the writer."""
    try:
        while True:
            chunk = await reader.read(BUFFER_SIZE)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    except asyncio.CancelledError:
        raise
    except Exception:
        # A single broken connection must never take the forwarder down.
        pass
    finally:
        try:
            if not writer.is_closing() and writer.can_write_eof():
                writer.write_eof()
        except Exception:
            pass


async def _close(writer: asyncio.StreamWriter | None) -> None:
    if writer is None:
        return
    try:
        writer.close()
        await writer.wait_closed()
    except Exception:
        pass


async def handle_client(
    client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter
) -> None:
    """One relayed connection: connect upstream, then shovel bytes both ways."""
    peer = client_writer.get_extra_info("peername")
    try:
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(TARGET_HOST, TARGET_PORT), timeout=CONNECT_TIMEOUT
        )
    except Exception as exc:
        # Expected while the SSH reverse tunnel / hub is down. Close silently so
        # the caller sees an empty/failed HTTP response, not a local answer.
        log.warning(
            "upstream %s:%s unavailable for %s: %s",
            TARGET_HOST,
            TARGET_PORT,
            peer,
            exc,
        )
        await _close(client_writer)
        return

    try:
        await asyncio.gather(
            _pipe(client_reader, upstream_writer),
            _pipe(upstream_reader, client_writer),
            return_exceptions=True,
        )
    finally:
        await _close(upstream_writer)
        await _close(client_writer)


async def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    server = await asyncio.start_server(
        handle_client, LISTEN_HOST, LISTEN_PORT, backlog=128, reuse_address=True
    )
    addrs = ", ".join(str(sock.getsockname()) for sock in (server.sockets or []))
    log.info("listening on %s -> %s:%s", addrs, TARGET_HOST, TARGET_PORT)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass

    async with server:
        await stop.wait()
    log.info("shutting down")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
