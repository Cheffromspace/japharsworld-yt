// netguard self-test fixture (test/netguard.test.js): a refusal at module load, then a passing test. 192.0.2.1 is
// TEST-NET-1 (RFC 5737): reserved, never a real host.
import test from 'node:test';
await fetch('http://192.0.2.1:9/').catch(() => {});
test('Q1 passes after a refusal at load', () => {});
