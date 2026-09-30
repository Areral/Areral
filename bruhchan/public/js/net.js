import { io } from '/socket.io/socket.io.esm.min.js';

export function connect(handlers) {
  const socket = io({ transports: ['websocket', 'polling'] });
  let entered = false;
  socket.on('connect', () => { if (entered) socket.emit('enter'); }); // re-enter after a reconnect
  socket.on('hello', (d) => handlers.onHello?.(d));
  socket.on('welcome', (d) => handlers.onWelcome?.(d.id));
  socket.on('players', (s) => handlers.onPlayers?.(s));
  socket.on('leave', (id) => handlers.onLeave?.(id));
  socket.on('thread:new', (m) => handlers.onThread?.(m));
  socket.on('thread:bump', (m) => handlers.onBump?.(m));
  return {
    enter() {
      entered = true;
      if (socket.connected) socket.emit('enter');
    },
    move(state) {
      if (entered && socket.connected) socket.volatile.emit('move', state.map((v) => Math.round(v * 100) / 100));
    },
  };
}
