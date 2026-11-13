import net from 'node:net';

/**
 * Can a TCP connection to the server be opened? Used when the credentials callback fails,
 * to tell "network down" (retry soon) from "token problem" (retry later).
 */
export function isReachable(host: string, port: number, timeout = 10 * 1000): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        const done = (reachable: boolean) => {
            socket.destroy();
            resolve(reachable);
        };
        socket.setTimeout(timeout, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}
