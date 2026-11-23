import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAlpacaErrorBody } from '../server/alpacaClient.ts';

test('parseAlpacaErrorBody extracts JSON message and code cleanly', () => {
  const parsed = parseAlpacaErrorBody(
    JSON.stringify({ message: 'subscription does not permit querying recent SIP data', code: 42210000 }),
    403,
  );
  assert.equal(parsed.message, 'subscription does not permit querying recent SIP data');
  assert.equal(parsed.alpacaCode, 42210000);
});

test('parseAlpacaErrorBody sanitizes HTML 401 responses without exposing raw HTML tags', () => {
  const html =
    '<html>\r\n<head><title>401 Authorization Required</title></head>\r\n<body>\r\n<center><h1>401 Authorization Required</h1></center>\r\n</body>\r\n</html>\r\n';
  const parsed = parseAlpacaErrorBody(html, 401);
  assert.ok(parsed.message);
  assert.ok(!parsed.message.includes('<html>'));
  assert.ok(!parsed.message.includes('<title>'));
  assert.match(parsed.message, /401 Authorization Required/);
  assert.match(parsed.message, /ALPACA_API_KEY_ID/);
});
