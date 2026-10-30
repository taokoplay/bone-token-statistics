const test = require('node:test');
const assert = require('node:assert/strict');
function fixture() {
  delete require.cache[require.resolve('../main.js')];
  const plugin = require('../main.js');
  const now = Date.now();
  const catalog = Array.from({length:45},(_,i)=>({id:i+1,name:`Project ${i+1}`,path:`/code/folder-${i+1}`}));
  const calls = [];
  let denied = false;
  global.pi = {
    plugin:{getSettings:async()=>({projectNames:{45:'Manual override'}})},
    usage:{listTurns:async()=>({turns:catalog.map(p=>({projectId:p.id,sessionId:`s${p.id}`,turnId:`t${p.id}`,startedAt:now-1000,endedAt:now,inputTokens:10,outputTokens:5,modelId:'model',providerId:'provider'})),nextCursor:null})},
    desktop:{invoke:async input=>{calls.push(input);if(denied)throw Object.assign(new Error('Permission denied'),{code:'PERMISSION_DENIED'});return {projects:catalog};}},
    session:{get:async()=>{throw new Error('session.get must never be called');}}
  };
  return {catalog,calls,deny:()=>{denied=true;},snapshot:()=>plugin.onPanelInvoke('stats.snapshot',{toMs:now,days:1,force:true})};
}
test('project catalog names resolve without transcript access, including beyond 40 projects',async()=>{
  const f=fixture();const s=await f.snapshot();assert.equal(s.ok,true);
  assert.equal(s.projects.find(p=>p.id===1).name,'Project 1');
  assert.equal(s.projects.find(p=>p.id===44).name,'Project 44');
  assert.equal(s.projects.find(p=>p.id===45).name,'Manual override');
  assert.deepEqual(f.calls,[{operation:'project/list',args:[]}]);
  assert.ok(s.sessions.some(row=>row.projectName?.startsWith('Project ')));
});
test('refresh picks up project rename instead of retaining a process-lifetime name',async()=>{
  const f=fixture();await f.snapshot();f.catalog[0].name='Renamed project';
  assert.equal((await f.snapshot()).projects.find(p=>p.id===1).name,'Renamed project');
});
test('permission denial keeps statistics and discloses the new permission',async()=>{
  const f=fixture();f.deny();const s=await f.snapshot();assert.equal(s.ok,true);assert.equal(s.totals.turns,45);
  assert.ok(s.notes.some(n=>n.includes('desktop.control')));
  assert.equal(s.projects.find(p=>p.id===45).name,'Manual override');
});
