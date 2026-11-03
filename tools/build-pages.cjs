/* Explicit allowlist: local clips, reports and Python services never enter dist. */
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'dist');
const assets=['index.html','app.js','tracker.js','styles.css','icon.svg','site.webmanifest'];
fs.mkdirSync(output,{recursive:true});
for(const name of fs.readdirSync(output)){
  if(![...assets,'.nojekyll'].includes(name))throw Error(`Unexpected file in dist: ${name}`);
}
for(const name of assets){
  let content=fs.readFileSync(path.join(root,'app',name),'utf8');
  if(name==='index.html'){
    content=content.replace('<script src="tracker.js" defer></script>','<script>window.SHOTBOOK_HOSTED=true;</script>\n  <script src="tracker.js" defer></script>');
    content=content.replace('影片留在你的裝置與本機電腦','影像在你的裝置內處理');
  }
  fs.writeFileSync(path.join(output,name),content);
}
fs.writeFileSync(path.join(output,'.nojekyll'),'');
console.log(`GitHub Pages: ${assets.length} app assets prepared in dist/`);
