/* Explicit allowlist: local clips, reports and Python services never enter dist. */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'dist');
const assets=['index.html','app.js','tracker.js','court.js','styles.css','icon.svg','site.webmanifest'];
fs.mkdirSync(output,{recursive:true});
for(const name of fs.readdirSync(output)){
  if(![...assets,'.nojekyll'].includes(name))throw Error(`Unexpected file in dist: ${name}`);
}
for(const name of assets){
  let content=fs.readFileSync(path.join(root,'app',name),'utf8');
  if(name==='index.html'){
    content=content.replace('<script src="tracker.js" defer></script>','<script>window.SHOTBOOK_HOSTED=true;</script>\n  <script src="tracker.js" defer></script>');
    content=content.replace('影片留在你的裝置與本機電腦','影像在你的裝置內處理');
    content=content.replace(/(src|href)="(app\.js|tracker\.js|court\.js|styles\.css|icon\.svg|site\.webmanifest)"/g,(_,attribute,asset)=>{
      const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'app',asset))).digest('hex').slice(0,12);
      return `${attribute}="${asset}?v=${hash}"`;
    });
  }
  fs.writeFileSync(path.join(output,name),content);
}
fs.writeFileSync(path.join(output,'.nojekyll'),'');
console.log(`GitHub Pages: ${assets.length} app assets prepared in dist/`);
