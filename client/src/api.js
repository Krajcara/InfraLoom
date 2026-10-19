const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const error = new Error(body?.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  get: (path) => request(path),
  post: (path, data) => request(path, { method: 'POST', body: data ? JSON.stringify(data) : undefined }),
  put: (path, data) => request(path, { method: 'PUT', body: data ? JSON.stringify(data) : undefined }),
  del: (path) => request(path, { method: 'DELETE' }),
  patch: (path, data) => request(path, { method: 'PATCH', body: data ? JSON.stringify(data) : undefined }),
  // a file as the body of the request; its name goes in X-Filename
  upload: (path, file) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file }),
};
