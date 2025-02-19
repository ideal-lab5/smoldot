// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Note: if you modify these imports, please test both the ModuleJS and CommonJS generated
// bindings. JavaScript being JavaScript, some libraries (such as `websocket`) have issues working
// with both at the same time.

import { Client, ClientOptionsWithBytecode } from './public-types.js'
import { start as innerStart, Connection, ConnectionConfig } from './internals/client.js'

import { WebSocket } from 'ws';

import { performance } from 'node:perf_hooks';
import { createConnection as nodeCreateConnection } from 'node:net';
import { randomFillSync } from 'node:crypto';

export {
    AddChainError,
    AddChainOptions,
    AlreadyDestroyedError,
    Chain,
    Client,
    ClientOptions,
    ClientOptionsWithBytecode,
    SmoldotBytecode,
    CrashError,
    MalformedJsonRpcError,
    QueueFullError,
    JsonRpcDisabledError,
    LogCallback
} from './public-types.js';

/**
 * Initializes a new client. This is a pre-requisite to connecting to a blockchain.
 *
 * Can never fail.
 *
 * @param options Configuration of the client.
 */
export function startWithBytecode(options: ClientOptionsWithBytecode): Client {
    options.forbidWebRtc = true;

    return innerStart(options || {}, options.bytecode, {
        performanceNow: () => {
            return performance.now()
        },
        getRandomValues: (buffer) => {
            if (buffer.length >= 1024 * 1024)
                throw new Error('getRandomValues buffer too large')
            randomFillSync(buffer)
        },
        connect: (config) => {
            return connect(config)
        }
    })
}

/**
 * Tries to open a new connection using the given configuration.
 *
 * @see Connection
 * @throws {@link ConnectionError} If the multiaddress couldn't be parsed or contains an invalid protocol.
 */
function connect(config: ConnectionConfig): Connection {
    if (config.address.ty === "websocket") {
        const socket = new WebSocket(config.address.url);
        socket.binaryType = 'arraybuffer';

        const bufferedAmountCheck = { quenedUnreportedBytes: 0, nextTimeout: 10 };
        const checkBufferedAmount = () => {
            if (socket.readyState != 1)
                return;
            // Note that we might expect `bufferedAmount` to always be <= the sum of the lengths
            // of all the data that has been sent, but that seems to not be the case. It is
            // unclear whether this is intended or a bug, but is is likely that `bufferedAmount`
            // also includes WebSocket headers. For this reason, we use `bufferedAmount` as a hint
            // rather than a correct value.
            const bufferedAmount = socket.bufferedAmount;
            let wasSent = bufferedAmountCheck.quenedUnreportedBytes - bufferedAmount;
            if (wasSent < 0) wasSent = 0;
            bufferedAmountCheck.quenedUnreportedBytes -= wasSent;
            if (bufferedAmountCheck.quenedUnreportedBytes != 0) {
                setTimeout(checkBufferedAmount, bufferedAmountCheck.nextTimeout);
                bufferedAmountCheck.nextTimeout *= 2;
                if (bufferedAmountCheck.nextTimeout > 500)
                    bufferedAmountCheck.nextTimeout = 500;
            }
            // Note: it is important to call `onWritableBytes` at the very end, as it might
            // trigger a call to `send`.
            if (wasSent != 0)
                config.onWritableBytes(wasSent);
        };

        socket.onopen = () => {
            config.onOpen({ type: 'single-stream', handshake: 'multistream-select-noise-yamux', initialWritableBytes: 1024 * 1024 });
        };
        socket.onclose = (event) => {
            const message = "Error code " + event.code + (!!event.reason ? (": " + event.reason) : "");
            config.onConnectionReset(message);
            socket.onopen = () => { };
            socket.onclose = () => { };
            socket.onmessage = () => { };
            socket.onerror = () => { };
        };
        socket.onerror = (event) => {
            config.onConnectionReset(event.message);
            socket.onopen = () => { };
            socket.onclose = () => { };
            socket.onmessage = () => { };
            socket.onerror = () => { };
        };
        socket.onmessage = (msg) => {
            config.onMessage(new Uint8Array(msg.data as ArrayBuffer));
        };

        return {
            reset: (): void => {
                // We can't set these fields to null because the TypeScript definitions don't
                // allow it, but we can set them to dummy values.
                socket.onopen = () => { };
                socket.onclose = () => { };
                socket.onmessage = () => { };
                socket.onerror = () => { };
                socket.close();
            },
            send: (data: Uint8Array): void => {
                socket.send(data);
                if (bufferedAmountCheck.quenedUnreportedBytes == 0) {
                    bufferedAmountCheck.nextTimeout = 10;
                    setTimeout(checkBufferedAmount, 10);
                }
                bufferedAmountCheck.quenedUnreportedBytes += data.length;
            },
            closeSend: (): void => { throw new Error('Wrong connection type') },
            openOutSubstream: () => { throw new Error('Wrong connection type') }
        };

    } else if (config.address.ty === "tcp") {
        const socket = nodeCreateConnection({
            host: config.address.hostname,
            port: config.address.port,
        });

        // Number of bytes queued using `socket.write` and where `write` has returned false.
        const drainingBytes = { num: 0 };

        socket.setNoDelay();

        socket.on('connect', () => {
            if (socket.destroyed) return;
            config.onOpen({
                type: 'single-stream', handshake: 'multistream-select-noise-yamux',
                initialWritableBytes: socket.writableHighWaterMark
            });
        });
        socket.on('close', (hasError) => {
            if (socket.destroyed) return;
            // NodeJS doesn't provide a reason why the closing happened, but only
            // whether it was caused by an error.
            const message = hasError ? "Error" : "Closed gracefully";
            config.onConnectionReset(message);
        });
        socket.on('error', () => { });
        socket.on('data', (message) => {
            if (socket.destroyed) return;
            config.onMessage(new Uint8Array(message.buffer));
        });
        socket.on('drain', () => {
            // The bytes queued using `socket.write` and where `write` has returned false have now
            // been sent. Notify the API that it can write more data.
            if (socket.destroyed) return;
            const val = drainingBytes.num;
            drainingBytes.num = 0;
            config.onWritableBytes(val);
        });

        return {
            reset: (): void => {
                socket.destroy();
            },
            send: (data: Uint8Array): void => {
                const dataLen = data.length;
                const allWritten = socket.write(data);
                if (allWritten) {
                    setImmediate(() => {
                        if (!socket.writable) return;
                        config.onWritableBytes(dataLen)
                    });
                } else {
                    drainingBytes.num += dataLen;
                }
            },
            closeSend: (): void => {
                socket.end();
            },
            openOutSubstream: () => { throw new Error('Wrong connection type') }
        };

    } else {
        // Should never happen, as we tweak the options to refuse connection types that
        // we don't support.
        throw new Error();
    }
}
