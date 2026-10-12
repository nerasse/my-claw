const { test } = require('node:test');
const assert = require('node:assert/strict');

test('IPv6 trust ranges cannot turn an arbitrary IPv4 client into a trusted proxy', () => {
  const proxyaddr = require('proxy-addr');
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    assert.equal(proxyaddr.compile([subnet])('203.0.113.3', 0), false);
  }
  const correct = proxyaddr.compile(['::ffff:10.0.0.0/104']);
  assert.equal(correct('10.1.2.3', 0), true);
  assert.equal(correct('203.0.113.3', 0), false);
});

test('format precision stays bounded for all numerical conversions', () => {
  const { sprintf } = require('sprintf-js');
  assert.equal(sprintf('%.2f', 1.25), '1.25');
  for (const type of ['e', 'f', 'g']) assert.ok(sprintf('%.100000000' + type, 1.25).length < 120);
});
