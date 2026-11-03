const fs=require('node:fs');
const {ShotTracker}=require('../app/tracker.js');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const tracker=new ShotTracker(input.hoop);
for(const row of input.frames)tracker.update(row.t,row.candidates);
tracker.finish(true);
process.stdout.write(JSON.stringify({events:tracker.events}));
