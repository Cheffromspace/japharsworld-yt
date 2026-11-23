// netguard self-test fixture: a passing test, then a refusal in an after() hook.
import test, { after } from 'node:test';
test('S1 passes', () => {});
after(async () => { await fetch('http://192.0.2.1:9/').catch(() => {}); });
