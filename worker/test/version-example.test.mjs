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

const hasRequired = tag => [...tag.matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+))?/g)].some(match => match[1].toLowerCase() === 'required');
test('required check uses the actual HTML attribute name', () => {
  assert.equal(hasRequired('<input REQUIRED>'), true);
  assert.equal(hasRequired('<input required="false">'), true);
  assert.equal(hasRequired('<input aria-required="false">'), false);
  assert.equal(hasRequired('<input placeholder="Version is not required">'), false);
});
