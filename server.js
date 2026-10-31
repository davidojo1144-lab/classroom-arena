const express=require('express'),http=require('http'),{Server}=require('socket.io'),crypto=require('crypto');
const app=express(),server=http.createServer(app),io=new Server(server),rooms=new Map();app.use(express.static('public'));
const makeCode=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
function view(r){const q=r.questions[r.index];return {code:r.code,status:r.status,index:r.index,total:r.questions.length,question:q?{text:q.text,choices:q.choices}:null,players:r.players.map(p=>({id:p.id,name:p.name,score:p.score,answered:p.answer!==null}))};}
io.on('connection',s=>{
s.on('create',({name},cb)=>{let c;do{c=makeCode()}while(rooms.has(c));const r={code:c,host:s.id,status:'lobby',index:-1,questions:[],players:[]};rooms.set(c,r);s.join(c);cb({ok:true,code:c});});
s.on('join',({code,name},cb)=>{const r=rooms.get((code||'').toUpperCase());if(!r)return cb({ok:false,error:'Room not found'});r.players.push({id:s.id,name:(name||'Player').slice(0,40),score:0,answer:null});s.join(r.code);io.to(r.code).emit('update',view(r));cb({ok:true,code:r.code});});
s.on('questions',({code,questions},cb)=>{const r=rooms.get(code);if(!r||r.host!==s.id)return cb({ok:false,error:'Referee only'});r.questions=questions;cb({ok:true});});
s.on('start',({code},cb)=>{const r=rooms.get(code);if(!r||r.host!==s.id||!r.questions.length)return cb({ok:false,error:'Add questions first'});r.status='playing';r.index=0;io.to(code).emit('update',view(r));cb({ok:true});});
s.on('answer',({code,choice},cb)=>{const r=rooms.get(code),p=r?.players.find(x=>x.id===s.id),q=r?.questions[r?.index];if(!p||r.status!=='playing'||p.answer!==null||!q)return cb({ok:false,error:'Answer unavailable or already locked'});p.answer=choice;if(choice===q.answer)p.score++;io.to(code).emit('update',view(r));cb({ok:true});});
s.on('next',({code},cb)=>{const r=rooms.get(code);if(!r||r.host!==s.id)return cb({ok:false,error:'Referee only'});r.index++;if(r.index>=r.questions.length)r.status='finished';else r.players.forEach(p=>p.answer=null);io.to(code).emit('update',view(r));cb({ok:true});});
});server.listen(process.env.PORT||3000);
