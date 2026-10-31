const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

const makeId = () => crypto.randomBytes(6).toString("hex").toUpperCase();
const makePlayerId = () => crypto.randomUUID();

const clean = (value, max = 4000) =>
  String(value ?? "").trim().slice(0, max);

function reply(callback, result) {
  if (typeof callback === "function") callback(result);
}

function findRoom(roomId) {
  return rooms.get(String(roomId || ""));
}

function findActiveRoomByCode(code) {
  const normalized = clean(code, 30).toUpperCase();

  return [...rooms.values()].find(room =>
    room.code === normalized &&
    room.status !== "finished"
  );
}

function isHost(room, socket) {
  return Boolean(
    room &&
    room.hostSocketId === socket.id &&
    socket.data.role === "host" &&
    socket.data.roomId === room.id
  );
}

function findPlayer(room, socket) {
  if (!room || socket.data.role !== "player") return null;
  if (socket.data.roomId !== room.id) return null;

  return room.players.find(player =>
    player.id === socket.data.playerId
  ) || null;
}

function approved(player) {
  return player.approved === true;
}

function answeredCount(player) {
  return player.answeredQuestions.length;
}

function questionView(question) {
  return {
    id: question.id,
    text: question.text,
    options: [...question.options],
    answered: question.answered,
    claimedBy: question.claimedBy,
    owner: question.claimedBy,
    status: question.answered
      ? "answered"
      : question.claimedBy
        ? "claimed"
        : "available"
  };
}

/*
 * The correct answer is deliberately not included in the
 * public question data sent to players.
 */
function view(room) {
  return {
    id: room.id,
    name: room.name,
    code: room.code,

    duration: room.duration,
    pickTime: room.pickTime,
    explainTime: room.explainTime,

    playerCount: room.playerCount,
    totalQuestions: room.totalQuestions,
    perPlayer: room.perPlayer,
    autoStart: room.autoStart,

    status: room.status,

    questions: room.questions.map(questionView),

    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,

      status: player.approved
        ? player.connected ? "approved" : "approved; disconnected"
        : "waiting for approval",

      approved: player.approved,
      connected: player.connected,
      online: player.connected ? "Online" : "Offline",
      connection: player.connected ? "Online" : "Offline",

      question: player.currentQuestion,
      answer: player.answer,
      feedback: player.feedback,

      answered: player.answeredQuestions.length,
      answeredCount: player.answeredQuestions.length,
      answeredQuestions: [...player.answeredQuestions]
    })),

    submissions: room.submissions.map(submission => ({
      ...submission
    })),

    current: room.current,
    deadline: room.deadline,
    startedAt: room.startedAt,
    sessionDeadline: room.sessionDeadline
  };
}

function emit(room) {
  io.to(room.id).emit("room:update", view(room));
}

/* -------------------------------------------------
   SESSION START RULES
-------------------------------------------------- */

function allPlayersApproved(room) {
  return (
    room.players.length === room.playerCount &&
    room.players.every(approved)
  );
}

function startRoom(room) {
  if (room.status !== "lobby") {
    return { ok: false, error: "The session has already started." };
  }

  if (room.questions.length !== room.totalQuestions) {
    return { ok: false, error: "The question bank is incomplete." };
  }

  if (!allPlayersApproved(room)) {
    return {
      ok: false,
      error: "All expected students must join and be approved first."
    };
  }

  room.status = "playing";
  room.startedAt = Date.now();

  room.sessionDeadline = room.duration > 0
    ? room.startedAt + room.duration * 60 * 1000
    : null;

  emit(room);

  return { ok: true };
}

function checkAutomaticStart(room) {
  if (room.autoStart && allPlayersApproved(room)) {
    startRoom(room);
  }
}

/* -------------------------------------------------
   CONNECTION HANDLING
-------------------------------------------------- */

io.on("connection", socket => {

  /* -----------------------------------------------
     CREATE ROOM
  ------------------------------------------------ */

  socket.on("room:create", (data = {}, callback) => {
    const name = clean(data.name, 100) || "Classroom Arena";
    const code = clean(data.code, 30).toUpperCase();

    const playerCount = Number(data.playerCount);
    const totalQuestions = Number(data.totalQuestions);

    const duration = Number(data.duration);
    const pickTime = Number(data.pickTime);
    const explainTime = Number(data.explainTime);

    const questions = data.questions;

    if (!code) {
      return reply(callback, {
        ok: false,
        error: "Set a player access code."
      });
    }

    if (findActiveRoomByCode(code)) {
      return reply(callback, {
        ok: false,
        error: "That access code is already being used by an active session."
      });
    }

    if (
      !Number.isInteger(playerCount) ||
      playerCount < 1 ||
      playerCount > 100
    ) {
      return reply(callback, {
        ok: false,
        error: "Enter a valid number of students."
      });
    }

    if (
      !Number.isInteger(totalQuestions) ||
      totalQuestions < 1 ||
      totalQuestions > 1000
    ) {
      return reply(callback, {
        ok: false,
        error: "Enter a valid total number of questions."
      });
    }

    if (totalQuestions % playerCount !== 0) {
      return reply(callback, {
        ok: false,
        error: "The total number of questions must divide evenly among students."
      });
    }

    if (
      !Array.isArray(questions) ||
      questions.length !== totalQuestions
    ) {
      return reply(callback, {
        ok: false,
        error: `The question bank must contain exactly ${totalQuestions} questions.`
      });
    }

    const cleanedQuestions = [];

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];

      const text = clean(question.text, 2000);
      const options = Array.isArray(question.options)
        ? question.options.slice(0, 4).map(option => clean(option, 500))
        : [];

      const correct = clean(question.correct, 1).toUpperCase();

      if (!text || options.length !== 4 || options.some(option => !option)) {
        return reply(callback, {
          ok: false,
          error: `Question ${i + 1} needs question text and four answer options.`
        });
      }

      if (!["A", "B", "C", "D"].includes(correct)) {
        return reply(callback, {
          ok: false,
          error: `Question ${i + 1} needs a correct answer from A to D.`
        });
      }

      cleanedQuestions.push({
        id: i,
        text,
        options,
        correct,
        answered: false,
        claimedBy: null
      });
    }

    const id = makeId();

    const room = {
      id,
      name,
      code,

      hostSocketId: socket.id,

      playerCount,
      totalQuestions,
      perPlayer: totalQuestions / playerCount,

      autoStart: Boolean(data.autoStart),

      duration: Number.isFinite(duration) && duration >= 0
        ? duration
        : 120,

      pickTime: Number.isFinite(pickTime) && pickTime >= 10
        ? pickTime
        : 60,

      explainTime: Number.isFinite(explainTime) && explainTime >= 10
        ? explainTime
        : 120,

      questions: cleanedQuestions,
      players: [],
      submissions: [],

      current: null,
      status: "lobby",

      startedAt: null,
      deadline: null,
      sessionDeadline: null
    };

    rooms.set(id, room);

    socket.join(id);
    socket.data.roomId = id;
    socket.data.role = "host";

    reply(callback, {
      ok: true,
      room: view(room)
    });

    emit(room);
  });

  /* -----------------------------------------------
     PLAYER JOIN OR RESUME
  ------------------------------------------------ */

  socket.on("room:join", (data = {}, callback) => {
    const code = clean(data.code, 30).toUpperCase();
    const name = clean(data.name, 50);

    if (!code || !name) {
      return reply(callback, {
        ok: false,
        error: "Enter your name and the room access code."
      });
    }

    const room = findActiveRoomByCode(code);

    if (!room) {
      return reply(callback, {
        ok: false,
        error: "Room not found or session has ended."
      });
    }

    let player = room.players.find(existing =>
      existing.name.toLowerCase() === name.toLowerCase()
    );

    if (!player) {
      if (room.status !== "lobby") {
        return reply(callback, {
          ok: false,
          error: "This session has already started. Only registered players can resume."
        });
      }

      if (room.players.length >= room.playerCount) {
        return reply(callback, {
          ok: false,
          error: "The room is full."
        });
      }

      player = {
        id: makePlayerId(),
        name,

        score: 0,

        approved: false,
        connected: false,
        socketId: null,

        currentQuestion: null,
        answer: null,
        feedback: null,

        answeredQuestions: [],

        locked: false,
        pickDeadline: null,
        explainDeadline: null
      };

      room.players.push(player);
    } else {
      /*
       * A returning player reconnects to their existing player
       * record instead of creating a duplicate.
       */
      if (
        player.socketId &&
        player.socketId !== socket.id
      ) {
        const oldSocket = io.sockets.sockets.get(player.socketId);

        if (oldSocket) {
          oldSocket.leave(room.id);
          oldSocket.emit("session:replaced");
        }
      }
    }

    player.socketId = socket.id;
    player.connected = true;

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.role = "player";
    socket.data.playerId = player.id;

    reply(callback, {
      ok: true,
      room: view(room),
      playerId: player.id,
      approved: player.approved
    });

    emit(room);

    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit("player:request", {
        id: player.id,
        name: player.name
      });
    }

    checkAutomaticStart(room);
  });

  /* -----------------------------------------------
     REFEREE APPROVAL
  ------------------------------------------------ */

  socket.on("host:approve", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, {
        ok: false,
        error: "Referee only."
      });
    }

    if (room.status !== "lobby") {
      return reply(callback, {
        ok: false,
        error: "Player approval is closed after the session starts."
      });
    }

    const player = room.players.find(p => p.id === data.playerId);

    if (!player) {
      return reply(callback, {
        ok: false,
        error: "Player not found."
      });
    }

    player.approved = true;

    reply(callback, { ok: true });

    checkAutomaticStart(room);
    emit(room);
  });

  /* -----------------------------------------------
     REFEREE REJECT / KICK PLAYER
  ------------------------------------------------ */

  socket.on("host:kick", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, {
        ok: false,
        error: "Referee only."
      });
    }

    const playerIndex = room.players.findIndex(
      player => player.id === data.playerId
    );

    if (playerIndex === -1) {
      return reply(callback, {
        ok: false,
        error: "Player not found."
      });
    }

    const player = room.players[playerIndex];

    if (player.socketId) {
      const playerSocket = io.sockets.sockets.get(player.socketId);

      if (playerSocket) {
        playerSocket.emit("player:removed");
        playerSocket.leave(room.id);
        playerSocket.data.roomId = null;
        playerSocket.data.role = null;
        playerSocket.data.playerId = null;
      }
    }

    /*
     * Release a question if the removed player had claimed one
     * but had not submitted it.
     */
    if (player.currentQuestion !== null) {
      const question = room.questions[player.currentQuestion];

      if (question && !question.answered) {
        question.claimedBy = null;
      }
    }

    room.players.splice(playerIndex, 1);

    reply(callback, { ok: true });

    emit(room);
  });

  /* -----------------------------------------------
     MANUAL SESSION START
  ------------------------------------------------ */

  socket.on("host:start", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, {
        ok: false,
        error: "Referee only."
      });
    }

    const result = startRoom(room);

    reply(callback, result);
  });

  /* -----------------------------------------------
     PLAYER CLAIMS A QUESTION
  ------------------------------------------------ */

  socket.on("player:pick", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player) {
      return reply(callback, {
        ok: false,
        error: "Player or room not found."
      });
    }

    if (!approved(player)) {
      return reply(callback, {
        ok: false,
        error: "Wait for referee approval."
      });
    }

    if (room.status !== "playing") {
      return reply(callback, {
        ok: false,
        error: "The session is not active."
      });
    }

    if (room.sessionDeadline && Date.now() >= room.sessionDeadline) {
      return reply(callback, {
        ok: false,
        error: "The session time has expired."
      });
    }

    if (player.currentQuestion !== null) {
      return reply(callback, {
        ok: false,
        error: "Submit your current question before choosing another."
      });
    }

    if (answeredCount(player) >= room.perPlayer) {
      return reply(callback, {
        ok: false,
        error: "You have reached your maximum number of questions."
      });
    }

    const index = Number(data.index);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= room.questions.length
    ) {
      return reply(callback, {
        ok: false,
        error: "Invalid question."
      });
    }

    const question = room.questions[index];

    /*
     * This is the global lock.
     * A question can only be claimed by one player at a time.
     */
    if (question.answered) {
      return reply(callback, {
        ok: false,
        error: "This question has already been answered."
      });
    }

    if (question.claimedBy && question.claimedBy !== player.id) {
      return reply(callback, {
        ok: false,
        error: "Another player has already claimed this question."
      });
    }

    question.claimedBy = player.id;

    player.currentQuestion = index;
    player.answer = null;
    player.feedback = null;
    player.locked = false;

    player.pickDeadline = Date.now() + room.pickTime * 1000;
    player.explainDeadline = null;

    player.status = "Selecting answer";

    room.current = index;
    room.deadline = player.pickDeadline;

    reply(callback, {
      ok: true,
      questionIndex: index
    });

    emit(room);
  });

  /* -----------------------------------------------
     PLAYER LOCKS THEIR ANSWER
  ------------------------------------------------ */

  socket.on("player:lock", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player || room.status !== "playing") {
      return reply(callback, {
        ok: false,
        error: "Player or active session not found."
      });
    }

    if (player.currentQuestion === null || player.locked) {
      return reply(callback, {
        ok: false,
        error: "There is no unlocked question to submit."
      });
    }

    if (
      player.pickDeadline &&
      Date.now() > player.pickDeadline
    ) {
      return reply(callback, {
        ok: false,
        error: "Your answer selection time has expired."
      });
    }

    const answer = clean(data.answer, 1).toUpperCase();

    if (!["A", "B", "C", "D"].includes(answer)) {
      return reply(callback, {
        ok: false,
        error: "Choose a valid answer."
      });
    }

    const question = room.questions[player.currentQuestion];

    if (!question || question.claimedBy !== player.id) {
      return reply(callback, {
        ok: false,
        error: "You no longer own this question."
      });
    }

    player.answer = answer;
    player.locked = true;
    player.status = "Answer locked; optional explanation";

    player.pickDeadline = null;
    player.explainDeadline = Date.now() + room.explainTime * 1000;

    reply(callback, { ok: true });

    emit(room);
  });

  /* -----------------------------------------------
     PLAYER SUBMITS ANSWER AND EXPLANATION
  ------------------------------------------------ */

  socket.on("player:submit", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player || room.status !== "playing") {
      return reply(callback, {
        ok: false,
        error: "Player or active session not found."
      });
    }

    if (player.currentQuestion === null) {
      return reply(callback, {
        ok: false,
        error: "There is no active question to submit."
      });
    }

    if (!player.locked) {
      return reply(callback, {
        ok: false,
        error: "Lock your answer before submitting."
      });
    }

    if (
      player.explainDeadline &&
      Date.now() > player.explainDeadline
    ) {
      data.feedback = "";
    }

    const index = player.currentQuestion;
    const question = room.questions[index];

    if (
      !question ||
      question.claimedBy !== player.id ||
      question.answered
    ) {
      return reply(callback, {
        ok: false,
        error: "This question is no longer available."
      });
    }

    const feedback = clean(data.feedback, 4000);

    const isCorrect = player.answer === question.correct;

    /*
     * The question becomes globally answered and unavailable
     * as soon as the player submits.
     */
    question.answered = true;
    question.claimedBy = player.id;

    player.answeredQuestions.push(index);
    player.feedback = feedback;
    player.status = "Submitted";

    const submission = {
      name: player.name,
      playerId: player.id,

      questionIndex: index,
      question: question.text,

      answer: player.answer,
      feedback,

      correct: question.correct,
      isCorrect,

      marks: 0,
      submittedAt: Date.now()
    };

    room.submissions.push(submission);

    /*
     * Clear the player's current question so they can select
     * another available question, up to their assigned limit.
     */
    player.currentQuestion = null;
    player.answer = null;
    player.locked = false;
    player.pickDeadline = null;
    player.explainDeadline = null;

    room.current = null;
    room.deadline = null;

    reply(callback, {
      ok: true,
      answeredQuestions: player.answeredQuestions.length,
      questionLimit: room.perPlayer
    });

    emit(room);
  });

  /* -----------------------------------------------
     REFEREE MARKS PLAYER
  ------------------------------------------------ */

  socket.on("host:mark", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, {
        ok: false,
        error: "Referee only."
      });
    }

    const player = room.players.find(
      p => p.id === data.playerId
    );

    if (!player) {
      return reply(callback, {
        ok: false,
        error: "Player not found."
      });
    }

    const marks = Number(data.marks);

    if (!Number.isFinite(marks) || marks < 0 || marks > 100) {
      return reply(callback, {
        ok: false,
        error: "Marks must be between 0 and 100."
      });
    }

    /*
     * Store marks against the latest submission from this player.
     * This avoids awarding the same marks repeatedly.
     */
    const submission = [...room.submissions]
      .reverse()
      .find(item => item.playerId === player.id);

    if (!submission) {
      return reply(callback, {
        ok: false,
        error: "No submission found for this player."
      });
    }

    const previousMarks = Number(submission.marks || 0);

    submission.marks = marks;
    player.score += marks - previousMarks;

    emit(room);

    reply(callback, { ok: true });
  });

  /* -----------------------------------------------
     REFEREE ENDS SESSION
  ------------------------------------------------ */

  socket.on("host:end", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, {
        ok: false,
        error: "Referee only."
      });
    }

    room.status = "finished";
    room.deadline = null;
    room.sessionDeadline = null;

    emit(room);

    reply(callback, { ok: true });

    /*
     * Keep the finished room record for its results.
     * Its access code becomes available for a new session
     * because only non-finished rooms block code reuse.
     */
  });

  /* -----------------------------------------------
     RESUME ROOM DATA
  ------------------------------------------------ */

  socket.on("room:resume", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!room) {
      return reply(callback, {
        ok: false,
        error: "Room no longer exists."
      });
    }

    const player = findPlayer(room, socket);
    const host = isHost(room, socket);

    if (!player && !host) {
      return reply(callback, {
        ok: false,
        error: "You are not registered in this room."
      });
    }

    socket.join(room.id);

    reply(callback, {
      ok: true,
      room: view(room)
    });
  });

  /* -----------------------------------------------
     DISCONNECT
  ------------------------------------------------ */

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        emit(room);
      }

      const player = room.players.find(
        p => p.socketId === socket.id
      );

      if (player) {
        player.connected = false;
        player.socketId = null;
        player.status = "Disconnected";

        /*
         * Do not delete the player or end the session.
         * Their submitted questions and score remain.
         * An unsubmitted claimed question stays reserved
         * until the player reconnects or the referee kicks them.
         */
        emit(room);
      }
    }
  });
});

/* -------------------------------------------------
   SESSION TIME LIMIT
-------------------------------------------------- */

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (
      room.status === "playing" &&
      room.sessionDeadline &&
      now >= room.sessionDeadline
    ) {
      room.status = "finished";
      room.deadline = null;

      emit(room);
    }
  }
}, 1000);

/* -------------------------------------------------
   START SERVER
-------------------------------------------------- */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Classroom Arena running on port ${PORT}`);
});
