// 演示用的下游服务：已实现，别改。
import net from 'node:net';

export function startMockDownstream({ host = '127.0.0.1' } = {}) {
  const sockets = new Set();
  let accepted = 0;

  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === 'PING') {
          socket.write('PONG\n');
        } else if (line === 'SLOW') {
          setTimeout(() => socket.write('SLOW-OK\n'), 150);
        } else if (line.startsWith('ECHO ')) {
          socket.write(`${line.slice(5)}\n`);
        } else {
          socket.write('ERR unknown\n');
        }
        index = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    listen: () => new Promise((resolve) => {
      server.listen(0, host, () => resolve(server.address().port));
    }),
    accepted: () => accepted,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    }),
  };
}
