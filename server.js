require("dotenv").config();
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-this-secret";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@quizarena.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const db = new DatabaseSync(path.join(__dirname, "quizarena.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin');
CREATE TABLE IF NOT EXISTS quizzes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT DEFAULT 'General', difficulty TEXT DEFAULT 'Medium', description TEXT DEFAULT '', negative_marking REAL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, quiz_id INTEGER NOT NULL, prompt TEXT NOT NULL, options TEXT NOT NULL, correct_index INTEGER NOT NULL, points INTEGER DEFAULT 1000, time_limit INTEGER DEFAULT 20, FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY, pin TEXT UNIQUE NOT NULL, quiz_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'lobby', current_index INTEGER DEFAULT -1, question_started_at INTEGER, created_at INTEGER NOT NULL, FOREIGN KEY(quiz_id) REFERENCES quizzes(id));
CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL, nickname TEXT NOT NULL, joined_at INTEGER NOT NULL, UNIQUE(room_id,nickname), FOREIGN KEY(room_id) REFERENCES rooms(id));
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL, player_id INTEGER NOT NULL, score INTEGER DEFAULT 0, elapsed_ms INTEGER DEFAULT 0, submitted_at INTEGER, UNIQUE(room_id,player_id), FOREIGN KEY(room_id) REFERENCES rooms(id), FOREIGN KEY(player_id) REFERENCES players(id));
CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL, question_id INTEGER NOT NULL, selected_index INTEGER, correct INTEGER DEFAULT 0, elapsed_ms INTEGER DEFAULT 0, points_awarded INTEGER DEFAULT 0, UNIQUE(attempt_id,question_id), FOREIGN KEY(attempt_id) REFERENCES attempts(id), FOREIGN KEY(question_id) REFERENCES questions(id));
`);
db.exec("PRAGMA foreign_keys = ON;");
const admin = db.prepare("SELECT id FROM users WHERE email=?").get(ADMIN_EMAIL);
if (!admin) db.prepare("INSERT INTO users(email,password_hash,role) VALUES(?,?,?)").run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 10), "admin");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
const sessionMiddleware = session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8*60*60*1000 }
});
app.use(sessionMiddleware);
io.engine.use((req, res, next) => sessionMiddleware(req, res, next));
app.use(express.static(path.join(__dirname, "public")));

const roomTimers = new Map();
const live = new Map(); // roomId -> { playerSockets: Map(playerId,socketId) }
const safeQuiz = id => {
  const quiz = db.prepare("SELECT * FROM quizzes WHERE id=?").get(id);
  if (!quiz) return null;
  quiz.questions = db.prepare("SELECT id,prompt,options,correct_index,points,time_limit FROM questions WHERE quiz_id=? ORDER BY id").all(id).map(q=>({...q, options:JSON.parse(q.options)}));
  return quiz;
};
const getRoom = pin => db.prepare("SELECT r.*,q.title,q.category,q.difficulty,q.negative_marking FROM rooms r JOIN quizzes q ON q.id=r.quiz_id WHERE r.pin=?").get(String(pin||"").trim());
const roomPlayers = roomId => db.prepare(`SELECT p.id,p.nickname,COALESCE(a.score,0) score,COALESCE(a.elapsed_ms,0) elapsed_ms,a.submitted_at
 FROM players p LEFT JOIN attempts a ON a.player_id=p.id AND a.room_id=p.room_id WHERE p.room_id=? ORDER BY a.score DESC, a.elapsed_ms ASC, p.joined_at ASC`).all(roomId);
function emitRoom(roomId, event, payload) { io.to("room:"+roomId).emit(event, payload); }
function roomSnapshot(room) {
  const quiz = safeQuiz(room.quiz_id);
  return { pin: room.pin, status: room.status, title: room.title, category: room.category, difficulty: room.difficulty,
    currentIndex: room.current_index, questionStartedAt: room.question_started_at, questions: quiz ? quiz.questions.map(q=>({id:q.id,prompt:q.prompt,options:q.options,points:q.points,time_limit:q.time_limit})) : [],
    players: roomPlayers(room.id).map(p=>({id:p.id,nickname:p.nickname,score:p.score,submitted:!!p.submitted_at})), negativeMarking: room.negative_marking };
}
function refreshRoom(roomId) {
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  if (room) emitRoom(roomId, "room:update", roomSnapshot(getRoom(room.pin)));
}
function clearRoomTimer(roomId) { if(roomTimers.has(roomId)){clearTimeout(roomTimers.get(roomId));roomTimers.delete(roomId);} }
function finishQuestion(roomId) {
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  if (!room || room.status !== "question") return;
  const quiz = safeQuiz(room.quiz_id);
  const q = quiz.questions[room.current_index];
  if (!q) return;
  db.prepare("UPDATE rooms SET status='reveal' WHERE id=?").run(roomId);
  emitRoom(roomId, "question:ended", {correct_index:q.correct_index, question_id:q.id});
  refreshRoom(roomId);
}
function scheduleQuestion(roomId) {
  clearRoomTimer(roomId);
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  if (!room || room.status !== "question") return;
  const q = safeQuiz(room.quiz_id)?.questions[room.current_index];
  if (!q) return;
  const remaining = Math.max(0, q.time_limit*1000 - (Date.now() - room.question_started_at));
  roomTimers.set(roomId, setTimeout(()=>finishQuestion(roomId), remaining));
}
function finishGame(roomId) {
  clearRoomTimer(roomId);
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  if (!room) return;
  // Create an attempt for every joined player, including players who left questions blank.
  const players = db.prepare("SELECT * FROM players WHERE room_id=?").all(roomId);
  const ensureAttempt = db.prepare("INSERT OR IGNORE INTO attempts(room_id,player_id,score,elapsed_ms) VALUES(?,?,0,0)");
  for (const player of players) {
    ensureAttempt.run(roomId, player.id);
    db.prepare("UPDATE attempts SET submitted_at=COALESCE(submitted_at,?) WHERE room_id=? AND player_id=?")
      .run(Date.now(), roomId, player.id);
  }
  const quiz = safeQuiz(room.quiz_id);
  db.prepare("UPDATE rooms SET status='finished',current_index=? WHERE id=?").run(quiz ? quiz.questions.length : 0, roomId);
  emitRoom(roomId, "game:finished", {leaderboard:roomPlayers(roomId)});
  refreshRoom(roomId);
}
function startQuestion(roomId, index) {
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  if (!room) return;
  const quiz = safeQuiz(room.quiz_id);
  if (!quiz || index >= quiz.questions.length) {
    finishGame(roomId);
    return;
  }
  const q = quiz.questions[index];
  db.prepare("UPDATE rooms SET status='question',current_index=?,question_started_at=? WHERE id=?").run(index, Date.now(), roomId);
  emitRoom(roomId, "question:start", {index, question:{id:q.id,prompt:q.prompt,options:q.options,points:q.points,time_limit:q.time_limit}, startedAt:Date.now()});
  refreshRoom(roomId);
  scheduleQuestion(roomId);
}
function requireAdmin(req,res,next){ if(req.session && req.session.adminId) return next(); res.status(401).json({error:"Please sign in as admin."}); }

app.get("/api/me", (req,res)=>res.json({admin:!!req.session.adminId, email:req.session.adminEmail||null}));
app.post("/api/admin/login", (req,res)=>{
  const email=String(req.body.email||"").toLowerCase().trim(), password=String(req.body.password||"");
  const user=db.prepare("SELECT * FROM users WHERE email=? AND role='admin'").get(email);
  if(!user || !bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:"Email or password is incorrect."});
  req.session.adminId=user.id; req.session.adminEmail=user.email; res.json({ok:true});
});
app.post("/api/admin/logout",(req,res)=>{req.session.destroy(()=>res.json({ok:true}));});
app.get("/api/admin/quizzes",requireAdmin,(req,res)=>{
  const quizzes=db.prepare(`SELECT q.*,COUNT(questions.id) question_count FROM quizzes q LEFT JOIN questions ON questions.quiz_id=q.id GROUP BY q.id ORDER BY q.created_at DESC`).all();
  res.json(quizzes);
});
app.post("/api/admin/quizzes",requireAdmin,(req,res)=>{
  const {title,category="General",difficulty="Medium",description="",negative_marking=0}=req.body;
  if(!String(title||"").trim()) return res.status(400).json({error:"Quiz title is required."});
  const result=db.prepare("INSERT INTO quizzes(title,category,difficulty,description,negative_marking) VALUES(?,?,?,?,?)").run(String(title).trim(),String(category).trim(),String(difficulty),String(description).trim(),Math.max(0,Math.min(1,Number(negative_marking)||0)));
  res.json({id:result.lastInsertRowid});
});
app.get("/api/admin/quizzes/:id",requireAdmin,(req,res)=>{
  const q=safeQuiz(Number(req.params.id)); if(!q)return res.status(404).json({error:"Quiz not found"}); res.json(q);
});
app.put("/api/admin/quizzes/:id",requireAdmin,(req,res)=>{
  const id=Number(req.params.id), {title,category="General",difficulty="Medium",description="",negative_marking=0}=req.body;
  if(!db.prepare("SELECT id FROM quizzes WHERE id=?").get(id))return res.status(404).json({error:"Quiz not found"});
  db.prepare("UPDATE quizzes SET title=?,category=?,difficulty=?,description=?,negative_marking=? WHERE id=?").run(String(title||"Untitled").trim(),String(category),String(difficulty),String(description),Math.max(0,Math.min(1,Number(negative_marking)||0)),id);
  res.json({ok:true});
});
app.post("/api/admin/quizzes/:id/questions",requireAdmin,(req,res)=>{
  const id=Number(req.params.id), {prompt,options,correct_index,points=1000,time_limit=20}=req.body;
  if(!db.prepare("SELECT id FROM quizzes WHERE id=?").get(id))return res.status(404).json({error:"Quiz not found"});
  if(!String(prompt||"").trim() || !Array.isArray(options)||options.length<2||options.some(o=>!String(o).trim())||!Number.isInteger(Number(correct_index))||Number(correct_index)<0||Number(correct_index)>=options.length) return res.status(400).json({error:"Add a question, at least two options, and choose the correct answer."});
  const result=db.prepare("INSERT INTO questions(quiz_id,prompt,options,correct_index,points,time_limit) VALUES(?,?,?,?,?,?)").run(id,String(prompt).trim(),JSON.stringify(options.map(String)),Number(correct_index),Math.max(100,Math.min(5000,Number(points)||1000)),Math.max(5,Math.min(120,Number(time_limit)||20)));
  res.json({id:result.lastInsertRowid});
});
app.delete("/api/admin/questions/:id",requireAdmin,(req,res)=>{db.prepare("DELETE FROM questions WHERE id=?").run(Number(req.params.id));res.json({ok:true});});
app.delete("/api/admin/quizzes/:id",requireAdmin,(req,res)=>{
  const id=Number(req.params.id);
  const rooms=db.prepare("SELECT id FROM rooms WHERE quiz_id=?").all(id); rooms.forEach(r=>clearRoomTimer(r.id));
  db.prepare("DELETE FROM answers WHERE attempt_id IN (SELECT id FROM attempts WHERE room_id IN (SELECT id FROM rooms WHERE quiz_id=?))").run(id);
  db.prepare("DELETE FROM attempts WHERE room_id IN (SELECT id FROM rooms WHERE quiz_id=?)").run(id);
  db.prepare("DELETE FROM players WHERE room_id IN (SELECT id FROM rooms WHERE quiz_id=?)").run(id);
  db.prepare("DELETE FROM rooms WHERE quiz_id=?").run(id); db.prepare("DELETE FROM questions WHERE quiz_id=?").run(id); db.prepare("DELETE FROM quizzes WHERE id=?").run(id); res.json({ok:true});
});
app.post("/api/admin/rooms",requireAdmin,(req,res)=>{
  const quizId=Number(req.body.quiz_id), quiz=safeQuiz(quizId);
  if(!quiz||!quiz.questions.length)return res.status(400).json({error:"Choose a quiz with at least one question."});
  let pin; do{pin=String(Math.floor(100000+Math.random()*900000));}while(db.prepare("SELECT id FROM rooms WHERE pin=? AND status!='finished'").get(pin));
  const result=db.prepare("INSERT INTO rooms(pin,quiz_id,status,current_index,created_at) VALUES(?,?,'lobby',-1,?)").run(pin,quizId,Date.now());
  live.set(Number(result.lastInsertRowid),{playerSockets:new Map()});
  res.json({pin,roomId:result.lastInsertRowid});
});
app.post("/api/admin/rooms/:pin/start",requireAdmin,(req,res)=>{
  const room=getRoom(req.params.pin); if(!room)return res.status(404).json({error:"Room not found"});
  if(room.status!=="lobby")return res.status(400).json({error:"This room has already started."});
  startQuestion(room.id,0); res.json({ok:true});
});
app.post("/api/admin/rooms/:pin/next",requireAdmin,(req,res)=>{
  const room=getRoom(req.params.pin); if(!room)return res.status(404).json({error:"Room not found"});
  if(room.status!=="reveal")return res.status(400).json({error:"Reveal the current answer before moving on."});
  startQuestion(room.id,room.current_index+1); res.json({ok:true});
});
app.get("/api/rooms/:pin",(req,res)=>{
  const room=getRoom(req.params.pin); if(!room)return res.status(404).json({error:"PIN not found. Check it and try again."});
  if(room.status==="finished")return res.status(410).json({error:"This quiz has finished."});
  res.json({pin:room.pin,title:room.title,category:room.category,difficulty:room.difficulty,status:room.status,players:roomPlayers(room.id).length});
});
app.get("/api/rooms/:pin/leaderboard",(req,res)=>{
  const room=getRoom(req.params.pin); if(!room)return res.status(404).json({error:"Room not found"});
  res.json(roomPlayers(room.id));
});
app.get("/api/rooms/:pin/review/:nickname",(req,res)=>{
  const room=getRoom(req.params.pin); if(!room)return res.status(404).json({error:"Room not found"});
  const player=db.prepare("SELECT * FROM players WHERE room_id=? AND nickname=?").get(room.id,decodeURIComponent(req.params.nickname));
  if(!player)return res.status(404).json({error:"Player not found"});
  const attempt=db.prepare("SELECT * FROM attempts WHERE room_id=? AND player_id=?").get(room.id,player.id);
  if(!attempt)return res.json({submitted:false,items:[]});
  const items=db.prepare(`SELECT q.prompt,q.options,q.correct_index,a.selected_index,COALESCE(a.correct,0) correct,COALESCE(a.points_awarded,0) points_awarded FROM questions q LEFT JOIN answers a ON a.question_id=q.id AND a.attempt_id=? WHERE q.quiz_id=? ORDER BY q.id`).all(attempt?.id || -1, room.quiz_id).map(a=>({...a,options:JSON.parse(a.options)}));
  res.json({submitted:!!attempt?.submitted_at,score:attempt?.score || 0,items});
});

io.on("connection",socket=>{
  socket.on("student:join",({pin,nickname})=>{
    const room=getRoom(pin);
    const clean=String(nickname||"").trim().replace(/\s+/g," ").slice(0,20);
    if(!room)return socket.emit("join:error",{message:"That PIN doesn't exist. Try again."});
    if(room.status==="finished")return socket.emit("join:error",{message:"This quiz has already finished."});
    if(clean.length<2)return socket.emit("join:error",{message:"Use a nickname with at least 2 characters."});
    let player=db.prepare("SELECT * FROM players WHERE room_id=? AND nickname=?").get(room.id,clean);
    if(!player){
      try { const result=db.prepare("INSERT INTO players(room_id,nickname,joined_at) VALUES(?,?,?)").run(room.id,clean,Date.now()); player={id:result.lastInsertRowid,room_id:room.id,nickname:clean}; }
      catch(e){return socket.emit("join:error",{message:"That nickname is already in use in this room."});}
    }
    const attempt=db.prepare("SELECT * FROM attempts WHERE room_id=? AND player_id=?").get(room.id,player.id);
    if(attempt && attempt.submitted_at)return socket.emit("join:error",{message:"You've already completed this quiz. One attempt per player."});
    socket.data.roomId=room.id; socket.data.playerId=player.id; socket.data.nickname=clean; socket.join("room:"+room.id);
    if(!live.has(room.id))live.set(room.id,{playerSockets:new Map()});
    live.get(room.id).playerSockets.set(player.id,socket.id);
    socket.emit("student:joined",{playerId:player.id,nickname:clean,room:roomSnapshot(room),resume:!!attempt});
    emitRoom(room.id,"players:update",{players:roomPlayers(room.id)});
    if(room.status==="question"){
      const q=safeQuiz(room.quiz_id).questions[room.current_index];
      socket.emit("question:start",{index:room.current_index,question:{id:q.id,prompt:q.prompt,options:q.options,points:q.points,time_limit:q.time_limit},startedAt:room.question_started_at});
      const ans=attempt?db.prepare("SELECT question_id FROM answers WHERE attempt_id=?").all(attempt.id):[];
      socket.emit("student:answered",{questionIds:ans.map(a=>a.question_id)});
    }
    if(room.status==="reveal")socket.emit("question:ended",{});
    if(room.status==="finished")socket.emit("game:finished",{leaderboard:roomPlayers(room.id)});
    refreshRoom(room.id);
  });
  socket.on("student:answer",({questionId,selectedIndex})=>{
    const {roomId,playerId}=socket.data;if(!roomId||playerId==null)return;
    const room=db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
    if(!room||room.status!=="question")return socket.emit("answer:error",{message:"This question is no longer active."});
    const quiz=safeQuiz(room.quiz_id), q=quiz.questions[room.current_index];
    if(!q||q.id!==Number(questionId)||!Number.isInteger(Number(selectedIndex))||Number(selectedIndex)<0||Number(selectedIndex)>=q.options.length)return;
    if(Date.now()>=room.question_started_at+q.time_limit*1000){finishQuestion(roomId);return socket.emit("answer:error",{message:"Time is up!"});}
    let attempt=db.prepare("SELECT * FROM attempts WHERE room_id=? AND player_id=?").get(roomId,playerId);
    if(!attempt){const result=db.prepare("INSERT INTO attempts(room_id,player_id,score,elapsed_ms) VALUES(?,?,0,0)").run(roomId,playerId);attempt={id:result.lastInsertRowid,score:0,elapsed_ms:0};}
    if(db.prepare("SELECT id FROM answers WHERE attempt_id=? AND question_id=?").get(attempt.id,q.id))return socket.emit("answer:error",{message:"Answer already locked."});
    const elapsed=Math.max(0,Date.now()-room.question_started_at), correct=Number(selectedIndex)===q.correct_index;
    const remaining=Math.max(0,1-elapsed/(q.time_limit*1000));
    const points=correct?Math.round(q.points*(0.5+0.5*remaining)): -Math.round(q.points*quiz.negative_marking);
    db.prepare("INSERT INTO answers(attempt_id,question_id,selected_index,correct,elapsed_ms,points_awarded) VALUES(?,?,?,?,?,?)").run(attempt.id,q.id,Number(selectedIndex),correct?1:0,elapsed,points);
    db.prepare("UPDATE attempts SET score=score+?,elapsed_ms=elapsed_ms+? WHERE id=?").run(points,elapsed,attempt.id);
    socket.emit("answer:locked",{correct,points,elapsed});
    emitRoom(roomId,"players:update",{players:roomPlayers(roomId)});
    refreshRoom(roomId);
  });
  socket.on("student:tab-switch",()=>{
    const {roomId,nickname}=socket.data;if(roomId)emitRoom(roomId,"host:integrity",{nickname,message:"switched tabs"});
  });
  socket.on("disconnect",()=>{const {roomId,playerId}=socket.data;if(roomId&&live.has(roomId)){live.get(roomId).playerSockets.delete(playerId);}});
});

// Restore timer behavior after a server restart.
for(const room of db.prepare("SELECT * FROM rooms WHERE status='question'").all()) scheduleQuestion(room.id);

app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log(`QuizArena running at http://localhost:${PORT}`));
