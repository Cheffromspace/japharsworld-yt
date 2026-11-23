// netguard self-test fixture: a refusal inside a test (it must fail, alone).
import test from 'node:test';
test('T1 fetches 192.0.2.1', async () => { await fetch('http://192.0.2.1:9/').catch(() => {}); });
test('T2 does nothing', () => {});
