/* Validate the exact deploy artifact, including project-site relative paths. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'dist');
const expected=['.nojekyll','index.html','app.js','tracker.js','court.js','styles.css','icon.svg','site.webmanifest'].sort();
assert.deepEqual(fs.readdirSync(dir).sort(),expected);
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
assert.ok(html.includes('window.SHOTBOOK_HOSTED=true'));
const base=new URL('https://example.github.io/basketball/');
for(const [,link] of html.matchAll(/(?:src|href)="([^"]+)"/g)){
  if(link==='./')continue;
  const url=new URL(link,base);
  if(url.pathname.endsWith('.js'))assert.match(url.search,/^\?v=[a-f0-9]{12}$/);
  assert.ok(url.pathname.startsWith('/basketball/'),link);
  assert.ok(fs.existsSync(path.join(dir,decodeURIComponent(url.pathname.slice('/basketball/'.length)))),link);
}
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'site.webmanifest'),'utf8'));
assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');
assert.ok(fs.statSync(path.join(dir,'app.js')).size<100000);
console.log('Pages artifact passed: asset allowlist, hosted mode, project paths, manifest');
