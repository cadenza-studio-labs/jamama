export function createLiveRoom({ url, token, onRoom, onEnded, onOffline, Socket = WebSocket, retryDelay = 1000 }) {
  let socket, timer, closed = false, attempts = 0;
  function connect() {
    if (closed) return;
    socket = new Socket(url);
    socket.onopen = () => { if (!closed) socket.send(JSON.stringify({ type: 'authenticate', token })); };
    socket.onmessage = (message) => {
      let packet;
      try { packet = JSON.parse(message.data); } catch { socket.close(); return; }
      if (packet.event === 'room' && packet.data?.code) { attempts = 0; onRoom(packet.data); }
      if (packet.event === 'ended') { closed = true; clearTimeout(timer); onEnded(); }
    };
    socket.onclose = () => {
      if (closed) return;
      onOffline();
      timer = setTimeout(connect, Math.min(retryDelay * 2 ** attempts++, 10000));
    };
    socket.onerror = () => {};
  }
  connect();
  return { close() { closed = true; clearTimeout(timer); socket?.close(); } };
}
