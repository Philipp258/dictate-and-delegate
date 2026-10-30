'use strict';
// A fake GitHub releases API for the e2e runs: GET /repos/<owner>/<repo>/releases answers with
// whatever the test set (releases()), so a check finds an update or none.

const http = require('http');

function startFakeGithub() {
  let list = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, agent: req.headers['user-agent'] || '', auth: req.headers.authorization || '' });
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/releases(\?|$)/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(list));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        releases: (l) => (list = l),
        requests,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { startFakeGithub };
