import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { send, HttpError } from '../worker/http.mjs';

test('串流消費者擲錯時回傳通用 chunk 錯誤，不洩漏消費者的錯誤內容', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    res.on('close', closed);
    res.write('payload');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await assert.rejects(send({ method: 'GET', url: `http://127.0.0.1:${server.address().port}`,
    onChunk: () => { throw new Error('synthetic-consumer-detail'); }
  }), error => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.kind, 'chunk');
    assert.equal(error.notSent, false);
    assert.doesNotMatch(error.message, /AI|synthetic-consumer-detail/);
    return true;
  });
  await disconnected;
});
