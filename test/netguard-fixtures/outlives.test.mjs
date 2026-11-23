// netguard self-test fixture: P10 leaves a timer that fetches after P10 has ended, while the innocent P11 runs.
import test from 'node:test';
test('P10 starts work that outlives it', () => { setTimeout(() => { fetch('http://192.0.2.1:9/').catch(() => {}); }, 50); });
test('P11 is innocent and stays green', async () => { await new Promise((done) => setTimeout(done, 300)); });
