const API_BASE = 'http://localhost:5000';

async function traceCode(code) {
  const resp = await fetch(`${API_BASE}/trace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    throw new Error(`Сервер вернул ошибку: ${resp.status}`);
  }
  return resp.json();
}
