const express=require('express'),http=require('http'),{Server}=require('socket.io'),crypto=require('crypto');
const app=express(),server=http.createServer(app),io=new Server(server);
app.use(express.static('public'));
const rooms=new Map(), makeCode=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
function view(r){return {id:r.id,name:r.name,code:r.code,duration:r.duration,pickTime:r.pickTime,explainTime:r.explainTime,status:r.status,questions:r.questions.map(q=>({text:q.text,options:q.options})),players:r.players.map(p=>({id:p.id,name:p.name,score:p.score,status:p.status,question:p.question,answer:p.answer,feedback:p.feedback,answered:p.answered})),submissions:r.submissions,current:r.current,deadline:r.deadline,sessionDeadline:r.sessionDeadline};}
function host(r,s){return r&&r.host===s.id}
function emit(r){io.to(r.id).emit('room:update',view(r))}
io.on('connection',s=>{
 s.on('room:create',({name,code,duration,pickTime,explainTime,questions},cb)=>{
  const id=makeCode(),roomCode=String(code||'').trim().toUpperCase();
  if(!roomCode)return cb({ok:false,error:'Set a player access code.'});
  if([...rooms.values()].some(r=>r.code===roomCode))return cb({ok:false,error:'That player code is already in use.'});
  const r={id,host:s.id,name:name||'Classroom Arena',code:roomCode,duration:Number(duration)||120,pickTime:Number(pickTime)||60,explainTime:Number(explainTime)||120,questions:Array.isArray(questions)?questions:[],players:[],submissions:[],current:null,status:'lobby',deadline:null,sessionDeadline:null};
  rooms.set(id,r);s.join(id);cb({ok:true,room:view(r)});
 });
 s.on('room:join',({code,name},cb)=>{
  const r=[...rooms.values()].find(x=>x.code===String(code||'').trim().toUpperCase());
  if(!r||r.status==='finished')return cb({ok:false,error:'Room not found or session finished.'});
  if(r.players.some(p=>p.name.toLowerCase()===String(name||'').trim().toLowerCase()))return cb({ok:false,error:'That name is already in the room.'});
  const p={id:s.id,name:String(name||'Player').trim().slice(0,50),score:0,status:'Joined; waiting',question:null,answer:null,feedback:null,answered:false};
  r.players.push(p);s.join(r.id);cb({ok:true,room:view(r),playerId:s.id});emit(r);
 });
 s.on('room:resume',({roomId},cb)=>{const r=rooms.get(roomId);if(!r)return cb({ok:false,error:'Room no longer exists.'});s.join(r.id);cb({ok:true,room:view(r)});});
 s.on('host:start',({roomId},cb)=>{const r=rooms.get(roomId);if(!host(r,s))return cb({ok:false,error:'Referee only.'});if(!r.questions.length)return cb({ok:false,error:'Add questions first.'});r.status='playing';r.sessionDeadline=Date.now()+r.duration*60000;emit(r);cb({ok:true});});
 s.on('player:pick',({roomId,index},cb)=>{const r=rooms.get(roomId),p=r?.players.find(x=>x.id===s.id);if(!p||r.status!=='playing'||p.question!==null)return cb({ok:false,error:'Not your turn or question already selected.'});if(!Number.isInteger(index)||index<0||index>=r.questions.length)return cb({ok:false,error:'Invalid question.'});p.question=index;p.answer=null;p.feedback=null;p.answered=false;p.status='Selecting answer';r.current=index;r.deadline=Date.now()+r.pickTime*1000;emit(r);cb({ok:true});});
 s.on('player:lock',({roomId,answer},cb)=>{const r=rooms.get(roomId),p=r?.players.find(x=>x.id===s.id);if(!p||p.question===null||p.answered||Date.now()>r.deadline)return cb({ok:false,error:'Answer window closed.'});p.answer=String(answer);p.status='Answer locked; optional explanation';r.deadline=Date.now()+r.explainTime*1000;emit(r);cb({ok:true});});
 s.on('player:submit',({roomId,feedback},cb)=>{const r=rooms.get(roomId),p=r?.players.find(x=>x.id===s.id);if(!p||p.question===null||p.answered)return cb({ok:false,error:'No active answer to submit.'});p.feedback=String(feedback||'').slice(0,4000);p.answered=true;p.status='Submitted';r.submissions.push({name:p.name,playerId:p.id,questionIndex:p.question,question:r.questions[p.question]?.text,answer:p.answer||'No option',feedback:p.feedback,correct:r.questions[p.question]?.correct||''});emit(r);cb({ok:true});});
 s.on('host:mark',({roomId,playerId,marks},cb)=>{const r=rooms.get(roomId);if(!host(r,s))return cb({ok:false,error:'Referee only.'});const p=r.players.find(x=>x.id===playerId);if(!p)return cb({ok:false,error:'Player not found.'});p.score+=Math.max(0,Math.min(100,Number(marks)||0));emit(r);cb({ok:true});});
 s.on('host:end',({roomId},cb)=>{const r=rooms.get(roomId);if(!host(r,s))return cb({ok:false,error:'Referee only.'});r.status='finished';emit(r);cb({ok:true});});
 s.on('disconnect',()=>{for(const r of rooms.values()){const p=r.players.find(x=>x.id===s.id);if(p){p.status='Disconnected';emit(r);}}});
});
setInterval(()=>{for(const r of rooms.values()){if(r.status==='playing'&&r.sessionDeadline&&Date.now()>=r.sessionDeadline){r.status='finished';emit(r);}}},1000);
server.listen(process.env.PORT||3000);
