// netguard self-test fixture: a refusal in a before() hook, then passing tests.
import test, { before } from 'node:test';
before(async () => { await fetch('http://192.0.2.1:9/').catch(() => {}); });
test('R1 passes after a before() hook\'s refusal', () => {});
test('R2 passes too', () => {});
