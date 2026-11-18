// Optional Encore relay (Cloudflare Worker).
// Only needed if your phone's browser blocks direct calls to the song recognition service.
// Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker → paste this → Deploy.
// Then put the worker's address (https://<name>.<you>.workers.dev) in Encore › Settings › Relay address.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/recognize') {
      return new Response('Encore relay is running.', { headers: CORS });
    }
    const upstream = await fetch('https://api.audd.io/', { method: 'POST', body: await request.formData() });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
