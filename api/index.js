const { handler } = require('../netlify/functions/api');

module.exports = async (req, res) => {
  let rawBody = '';
  if (req.body && typeof req.body === 'object') {
    rawBody = JSON.stringify(req.body);
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else {
    rawBody = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  const event = {
    httpMethod: req.method,
    path: parsedUrl.pathname === '/webhook/checkbook' ? '/api/webhook/checkbook' : parsedUrl.pathname,
    queryStringParameters: query,
    headers: req.headers || {},
    body: rawBody
  };

  const result = await handler(event);
  const headers = result.headers || { 'Content-Type': 'application/json' };
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.status(result.statusCode || 200).send(result.body || '');
};
