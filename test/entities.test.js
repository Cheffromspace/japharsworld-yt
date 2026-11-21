// Everything-is-OK#967 (the round 3 verifier's R3-L10): caption text decodes named HTML entities from a small table;
// a name the table only inherits ("&constructor;", "&toString;") must stay as text, not become a function's source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities } from '../src/cues.js';

test('decodeEntities: the table\'s own names decode; inherited Object names and unknown names stay as written', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27; f&nbsp;g'), 'a & b <c> "d" \'e\' f g');
  for (const w of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'unknown']) {
    assert.equal(decodeEntities(`x &${w}; y`), `x &${w}; y`, w);
  }
});
