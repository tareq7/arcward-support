import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('release candidate support version example is 1.0.0 and version remains optional',()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const field=html.match(/<input\b[^>]*\bname="theme_version"[^>]*>/)?.[0];
 assert.ok(field);
 assert.match(field,/placeholder="e\.g\. 1\.0\.0"/);
 assert.doesNotMatch(field,/\brequired\b/);
});
