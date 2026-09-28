// 连下游的驱动：已实现，别改。
//
// 下游的协议很简单：一行一个请求，一行一个响应。同一条连接上一次只发一个请求。
import net from 'node:net';

export function createTcpDriver({ host = '127.0.0.1', port, connectTimeoutMs = 2000 } = {}) {
  let nextId = 1;

  function isBroken(conn) {
    return conn.broken || conn.socket.destroyed || !conn.socket.writable;
  }

  return {
    open() {
      return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const conn = { id: `conn-${nextId}`, socket, broken: false };
        nextId += 1;
        const timer = setTimeout(() => {
          conn.broken = true;
          socket.destroy();
          reject(new Error('connect timeout'));
        }, connectTimeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve(conn);
        });
        socket.on('error', (err) => {
          conn.broken = true;
          clearTimeout(timer);
          reject(err);
        });
        socket.on('close', () => {
          conn.broken = true;
        });
      });
    },

    close(conn) {
      conn.broken = true;
      return new Promise((resolve) => {
        conn.socket.destroy();
        setImmediate(resolve);
      });
    },

    isBroken,

    send(conn, line) {
      return new Promise((resolve, reject) => {
        if (isBroken(conn)) {
          reject(new Error('connection is broken'));
          return;
        }
        let buffer = '';
        const cleanup = () => {
          conn.socket.off('data', onData);
          conn.socket.off('close', onClose);
        };
        const onData = (chunk) => {
          buffer += chunk;
          const index = buffer.indexOf('\n');
          if (index === -1) {
            return;
          }
          cleanup();
          resolve(buffer.slice(0, index));
        };
        const onClose = () => {
          cleanup();
          conn.broken = true;
          reject(new Error('connection closed'));
        };
        conn.socket.on('data', onData);
        conn.socket.once('close', onClose);
        conn.socket.write(`${line}\n`);
      });
    },
  };
}
