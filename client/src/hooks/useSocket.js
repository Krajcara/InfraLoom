import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

let socket = null;

export function getSocket() {
  if (!socket) {
    // Cookies are sent automatically (same-origin), so no manual auth token needed.
    socket = io('/', { reconnectionAttempts: 5, reconnectionDelay: 2000 });
  }
  return socket;
}

export function useSocket(handlers = {}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const s = getSocket();
    const events = Object.keys(handlersRef.current);
    events.forEach((event) => {
      s.on(event, (...args) => handlersRef.current[event]?.(...args));
    });
    return () => {
      events.forEach((event) => s.off(event));
    };
  }, []);
}
