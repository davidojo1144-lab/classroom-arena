
"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json({ limit: "2mb" }));

const rooms = new Map();

const makeId = () => crypto.randomUUID();
const makeCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();
const makeToken = () => crypto.randomBytes(32).toString("hex");

const clean = (value, max = 4000) =>
  String(value ?? "").trim().slice(0, max);

function reply(callback, result) {
  if (typeof callback === "function") callback(result);
}

function findRoom(id) {
  return rooms.get(String(id || ""));
}

function findActiveRoomByCode(code) {
  const normalized = clean(code, 30).toUpperCase();

  return [...rooms.values()].find(room =>
    room.code === normalized && room.status !== "finished"
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

  return room.players.find(p => p.id === socket.data.playerId) || null;
}

function cleanQuestion(question, index) {
  const text = clean(question?.text, 2000);

  const options = Array.isArray(question?.options)
    ? question.options.slice(0, 4).map(x => clean(x, 500))
    : [];

  const correct = clean(question?.correct, 1).toUpperCase();

  if (!text || options.length !== 4 || options.some(x => !x)) {
    throw new Error(`Question ${index + 1} needs text and four options.`);
  }

  if (!["A", "B", "C", "D"].includes(correct)) {
    throw new Error(`Question ${index + 1} needs a correct answer from A to D.`);
  }

  return {
    id: question.id || makeId(),
    text,
    options,
    correct,
    answered: false,
    claimedBy: null,
    buzzerActive: false
  };
}

function publicQuestion(q) {
  return {
    id: q.id,
    text: q.text,
    options: [...q.options],
    answered: q.answered,
    claimedBy: q.claimedBy,
    buzzerActive: Boolean(q.buzzerActive),
    status: q.answered
      ? "answered"
      : q.buzzerActive
        ? "buzzer"
        : q.claimedBy
          ? "claimed"
          : "available"
  };
}

function publicView(room) {
  return {
    id: room.id,
    name: room.name,
    code: room.code,
    status: room.status,

    duration: room.duration,
    pickTime: room.pickTime,
    explainTime: room.explainTime,

    questions: room.questions.map(publicQuestion),

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      approved: p.approved,
      connected: p.connected,
      status: p.status,
      answeredCount: p.answeredQuestions.length,
      answeredQuestions: [...p.answeredQuestions],
      isCurrentTurn: room.currentTurnPlayerId === p.id,

      canBuzz: Boolean(
        room.buzzer &&
        room.buzzer.active &&
        room.buzzer.eligiblePlayerIds.includes(p.id) &&
        !room.buzzer.claimantPlayerId
      ),

      isBuzzerPlayer: Boolean(
        room.buzzer &&
        room.buzzer.claimantPlayerId === p.id
      )
    })),

    buzzer: room.buzzer
      ? {
          active: room.buzzer.active,
          questionId: room.buzzer.questionId,
          originalPlayerId: room.buzzer.originalPlayerId,
          claimantPlayerId: room.buzzer.claimantPlayerId,
          deadline: room.buzzer.deadline
        }
      : null,

    currentTurnPlayerId: room.currentTurnPlayerId,
    turnNumber: room.turnNumber,
    startedAt: room.startedAt,
    sessionDeadline: room.sessionDeadline
  };
}

function refereeView(room) {
  return {
    ...publicView(room),

    playerCount: room.playerCount,
    autoStart: room.autoStart,

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      approved: p.approved,
      connected: p.connected,
      status: p.status,
      answeredCount: p.answeredQuestions.length,
      answeredQuestions: [...p.answeredQuestions],
      currentQuestion: p.currentQuestion,
      currentAnswer: p.answer,
      currentFeedback: p.feedback,
      isCurrentTurn: room.currentTurnPlayerId === p.id,

      canBuzz: Boolean(
        room.buzzer &&
        room.buzzer.active &&
        room.buzzer.eligiblePlayerIds.includes(p.id) &&
        !room.buzzer.claimantPlayerId
      ),

      isBuzzerPlayer: Boolean(
        room.buzzer &&
        room.buzzer.claimantPlayerId === p.id
      ),

      history: room.submissions
        .filter(s => s.playerId === p.id)
        .map(s => ({ ...s }))
    })),

    submissions: room.submissions.map(s => ({ ...s }))
  };
}

function emit(room) {
  io.to(room.id).emit("room:update", publicView(room));

  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit("host:update", refereeView(room));
  }
}

function allPlayersApproved(room) {
  return (
    room.players.length === room.playerCount &&
    room.players.every(p => p.approved)
  );
}

function availableQuestions(room) {
  return room.questions.filter(q =>
    !q.answered && !q.claimedBy && !q.buzzerActive
  );
}

function finishRoom(room) {
  room.status = "finished";
  room.deadline = null;
  room.sessionDeadline = null;
  room.currentTurnPlayerId = null;
  room.current = null;
  room.buzzer = null;

  room.questions.forEach(q => {
    q.buzzerActive = false;
  });

  emit(room);
}

function startRoom(room) {
  if (room.status !== "lobby") {
    return { ok: false, error: "The session has already started." };
  }

  if (!room.questions.length) {
    return { ok: false, error: "Add or generate questions first." };
  }

  if (!allPlayersApproved(room)) {
    return {
      ok: false,
      error: "All expected players must join and be approved first."
    };
  }

  room.status = "playing";
  room.startedAt = Date.now();
  room.turnNumber = 1;
  room.currentTurnPlayerId = room.players[0].id;

  room.sessionDeadline = room.duration > 0
    ? Date.now() + room.duration * 60000
    : null;

  emit(room);
  return { ok: true };
}

function checkAutomaticStart(room) {
  if (room.autoStart && allPlayersApproved(room)) {
    startRoom(room);
  }
}

function advanceTurn(room, previousPlayerId) {
  room.buzzer = null;

  const players = room.players.filter(p => p.approved);

  if (!players.length || !availableQuestions(room).length) {
    finishRoom(room);
    return;
  }

  const previousIndex = players.findIndex(p => p.id === previousPlayerId);

  for (let step = 1; step <= players.length; step++) {
    const next = players[(previousIndex + step) % players.length];

    if (next && next.approved) {
      room.currentTurnPlayerId = next.id;
      room.turnNumber += 1;
      room.current = null;
      room.deadline = null;
      emit(room);
      return;
    }
  }

  finishRoom(room);
}

function closeBuzzerQuestion(room, statusMessage) {
  const buzzer = room.buzzer;
  if (!buzzer) return;

  const question = room.questions.find(
    q => q.id === buzzer.questionId
  );

  if (question) {
    question.answered = true;
    question.buzzerActive = false;
  }

  const claimant = room.players.find(
    p => p.id === buzzer.claimantPlayerId
  );

  if (claimant && statusMessage) {
    claimant.status = statusMessage;
  }

  const originalPlayerId = buzzer.originalPlayerId;

  room.buzzer = null;
  room.current = null;
  room.deadline = null;

  advanceTurn(room, originalPlayerId);
}

// Start the buzzer round after a player's selection time expires.
function startBuzzer(room, timedOutPlayer) {
  const question = room.questions.find(
    q => q.id === timedOutPlayer.currentQuestion
  );

  if (!question || question.answered) {
    timedOutPlayer.currentQuestion = null;
    timedOutPlayer.answer = null;
    timedOutPlayer.feedback = null;
    timedOutPlayer.pickDeadline = null;
    advanceTurn(room, timedOutPlayer.id);
    return;
  }

  question.claimedBy = null;
  question.buzzerActive = true;

  timedOutPlayer.currentQuestion = null;
  timedOutPlayer.answer = null;
  timedOutPlayer.feedback = null;
  timedOutPlayer.pickDeadline = null;
  timedOutPlayer.status = "Selection time expired";

  room.current = null;
  room.deadline = null;

  const eligiblePlayerIds = room.players
    .filter(p =>
      p.approved &&
      p.connected &&
      p.id !== timedOutPlayer.id
    )
    .map(p => p.id);

  if (!eligiblePlayerIds.length) {
    question.buzzerActive = false;
    question.answered = true;
    advanceTurn(room, timedOutPlayer.id);
    return;
  }

  room.buzzer = {
    active: true,
    questionId: question.id,
    originalPlayerId: timedOutPlayer.id,
    eligiblePlayerIds,
    claimantPlayerId: null,

    // FIX: the unclaimed buzzer must also expire.
    deadline: Date.now() + room.pickTime * 1000
  };

  emit(room);
}

function resolveBuzzer(room, player, answer) {
  const buzzer = room.buzzer;

  if (!buzzer || !buzzer.active ||
      buzzer.claimantPlayerId !== player.id) {
    return { ok: false, error: "You do not hold this buzzer question." };
  }

  if (buzzer.deadline && Date.now() >= buzzer.deadline) {
    return { ok: false, error: "Your buzzer answer time has expired." };
  }

  const question = room.questions.find(
    q => q.id === buzzer.questionId
  );

  if (!question || question.answered) {
    return { ok: false, error: "This question is no longer available." };
  }

  const selectedAnswer = clean(answer, 1).toUpperCase();

  if (!["A", "B", "C", "D"].includes(selectedAnswer)) {
    return { ok: false, error: "Choose A, B, C or D." };
  }

  const isCorrect = selectedAnswer === question.correct;

  question.answered = true;
  question.buzzerActive = false;
  question.claimedBy = player.id;

  const bonusMarks = isCorrect ? 1 : 0;
  player.score += bonusMarks;

  const submission = {
    id: makeId(),
    playerId: player.id,
    name: player.name,
    questionId: question.id,
    questionIndex: room.questions.indexOf(question),
    question: question.text,
    options: [...question.options],
    answer: selectedAnswer,
    feedback: "",
    correct: question.correct,
    isCorrect,
    marks: bonusMarks,
    bonusMarks,
    buzzer: true,
    submittedAt: Date.now()
  };

  room.submissions.push(submission);
  player.answeredQuestions.push(question.id);
  player.status = isCorrect
    ? "Correct buzzer answer — 1 bonus mark"
    : "Incorrect buzzer answer — question closed";

  const originalPlayerId = buzzer.originalPlayerId;

  room.buzzer = null;
  room.current = null;
  room.deadline = null;

  advanceTurn(room, originalPlayerId);

  return {
    ok: true,
    correct: isCorrect,
    bonusMarks,
    questionClosed: true,
    submissionId: submission.id
  };
}

io.on("connection", socket => {

  socket.on("room:create", (data = {}, callback) => {
    const name = clean(data.name, 100) || "Classroom Arena";
    const code = clean(data.code, 30).toUpperCase();

    const playerCount = Number(data.playerCount);
    const questionsInput = Array.isArray(data.questions)
      ? data.questions
      : [];

    if (!code) {
      return reply(callback, {
        ok: false,
        error: "Set a referee room/access code."
      });
    }

    if (findActiveRoomByCode(code)) {
      return reply(callback, {
        ok: false,
        error: "That room number is already being used by an active referee session."
      });
    }

    if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 100) {
      return reply(callback, {
        ok: false,
        error: "Enter a valid number of players."
      });
    }

    let questions;

    try {
      questions = questionsInput.map(cleanQuestion);
    } catch (error) {
      return reply(callback, { ok: false, error: error.message });
    }

    const id = makeId();
    const hostToken = makeToken();

    const room = {
      id,
      name,
      code,

      hostToken,
      hostSocketId: socket.id,

      playerCount,
      autoStart: Boolean(data.autoStart),

      duration: Math.max(0, Number(data.duration) || 120),
      pickTime: Math.max(10, Number(data.pickTime) || 60),
      explainTime: Math.max(0, Number(data.explainTime) || 120),

      questions,
      players: [],
      submissions: [],

      current: null,
      currentTurnPlayerId: null,
      turnNumber: 0,
      buzzer: null,

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
      room: refereeView(room),
      hostToken
    });

    emit(room);
  });

  socket.on("host:resume", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!room || !data.hostToken || data.hostToken !== room.hostToken) {
      return reply(callback, {
        ok: false,
        error: "Invalid referee recovery details."
      });
    }

    if (room.hostSocketId && room.hostSocketId !== socket.id) {
      const old = io.sockets.sockets.get(room.hostSocketId);
      if (old) old.emit("session:replaced");
    }

    room.hostSocketId = socket.id;

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.role = "host";

    reply(callback, {
      ok: true,
      room: refereeView(room),
      hostToken: room.hostToken
    });

    emit(room);
  });

  socket.on("room:join", (data = {}, callback) => {
    const code = clean(data.code, 30).toUpperCase();
    const name = clean(data.name, 50);

    if (!code || !name) {
      return reply(callback, {
        ok: false,
        error: "Enter your name and room number."
      });
    }

    const room = findActiveRoomByCode(code);

    if (!room) {
      return reply(callback, {
        ok: false,
        error: "Room not found or session has ended."
      });
    }

    let player = room.players.find(p =>
      p.name.toLowerCase() === name.toLowerCase()
    );

    if (player) {
      if (!data.resumeToken || data.resumeToken !== player.resumeToken) {
        return reply(callback, {
          ok: false,
          error: "This player name is already registered. Use your recovery details to resume."
        });
      }

      if (player.socketId && player.socketId !== socket.id) {
        const old = io.sockets.sockets.get(player.socketId);
        if (old) old.emit("session:replaced");
      }
    } else {
      if (room.status !== "lobby") {
        return reply(callback, {
          ok: false,
          error: "The session has started. Only registered players can resume."
        });
      }

      if (room.players.length >= room.playerCount) {
        return reply(callback, {
          ok: false,
          error: "The room is full."
        });
      }

      player = {
        id: makeId(),
        resumeToken: makeToken(),
        name,
        score: 0,

        approved: false,
        connected: false,
        socketId: null,

        currentQuestion: null,
        answer: null,
        feedback: null,
        pickDeadline: null,

        answeredQuestions: [],
        status: "Waiting for approval"
      };

      room.players.push(player);
    }

    player.socketId = socket.id;
    player.connected = true;

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.role = "player";
    socket.data.playerId = player.id;

    reply(callback, {
      ok: true,
      room: publicView(room),
      playerId: player.id,
      resumeToken: player.resumeToken,
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

  socket.on("host:approve", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, { ok: false, error: "Referee only." });
    }

    if (room.status !== "lobby") {
      return reply(callback, {
        ok: false,
        error: "Approval is closed after the session starts."
      });
    }

    const player = room.players.find(p => p.id === data.playerId);

    if (!player) {
      return reply(callback, { ok: false, error: "Player not found." });
    }

    player.approved = true;
    player.status = "Approved";

    reply(callback, { ok: true });

    checkAutomaticStart(room);
    emit(room);
  });

  socket.on("host:kick", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, { ok: false, error: "Referee only." });
    }

    const index = room.players.findIndex(p => p.id === data.playerId);

    if (index < 0) {
      return reply(callback, { ok: false, error: "Player not found." });
    }

    const player = room.players[index];

    if (room.buzzer && room.buzzer.claimantPlayerId === player.id) {
      closeBuzzerQuestion(room, "Buzzer attempt ended — question closed");
    } else if (player.currentQuestion) {
      const question = room.questions.find(
        q => q.id === player.currentQuestion
      );

      if (question && !question.answered) {
        question.claimedBy = null;
      }
    }

    if (room.buzzer) {
      room.buzzer.eligiblePlayerIds =
        room.buzzer.eligiblePlayerIds.filter(id => id !== player.id);
    }

    const playerSocket = io.sockets.sockets.get(player.socketId);

    if (playerSocket) {
      playerSocket.emit("player:removed");
      playerSocket.leave(room.id);
    }

    room.players.splice(index, 1);

    if (room.status === "playing" &&
        room.currentTurnPlayerId === player.id) {
      advanceTurn(room, player.id);
    } else {
      emit(room);
    }

    reply(callback, { ok: true });
  });

  socket.on("host:questions:update", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, { ok: false, error: "Referee only." });
    }

    if (room.status !== "lobby") {
      return reply(callback, {
        ok: false,
        error: "The question bank can only be edited before the session starts."
      });
    }

    if (!Array.isArray(data.questions)) {
      return reply(callback, {
        ok: false,
        error: "Send a valid question list."
      });
    }

    try {
      room.questions = data.questions.map(cleanQuestion);
    } catch (error) {
      return reply(callback, { ok: false, error: error.message });
    }

    emit(room);
    reply(callback, { ok: true, totalQuestions: room.questions.length });
  });

  socket.on("host:question:add", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket) || room.status !== "lobby") {
      return reply(callback, {
        ok: false,
        error: "Only the referee can add questions before the session starts."
      });
    }

    try {
      room.questions.push(cleanQuestion(data.question, room.questions.length));
    } catch (error) {
      return reply(callback, { ok: false, error: error.message });
    }

    emit(room);
    reply(callback, { ok: true });
  });

  socket.on("host:question:edit", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket) || room.status !== "lobby") {
      return reply(callback, {
        ok: false,
        error: "Questions can only be edited before the session starts."
      });
    }

    const index = Number.isInteger(Number(data.index))
      ? Number(data.index)
      : room.questions.findIndex(q => q.id === data.questionId);

    if (index < 0 || index >= room.questions.length) {
      return reply(callback, { ok: false, error: "Question not found." });
    }

    try {
      room.questions[index] = cleanQuestion({
        ...data.question,
        id: room.questions[index].id
      }, index);
    } catch (error) {
      return reply(callback, { ok: false, error: error.message });
    }

    emit(room);
    reply(callback, { ok: true });
  });

  socket.on("host:question:delete", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket) || room.status !== "lobby") {
      return reply(callback, {
        ok: false,
        error: "Questions can only be removed before the session starts."
      });
    }

    const index = Number.isInteger(Number(data.index))
      ? Number(data.index)
      : room.questions.findIndex(q => q.id === data.questionId);

    if (index < 0 || index >= room.questions.length) {
      return reply(callback, { ok: false, error: "Question not found." });
    }

    room.questions.splice(index, 1);

    emit(room);
    reply(callback, { ok: true });
  });

  socket.on("host:start", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, { ok: false, error: "Referee only." });
    }

    const result = startRoom(room);
    reply(callback, result);
  });

  socket.on("player:pick", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player) {
      return reply(callback, { ok: false, error: "Player or room not found." });
    }

    if (!player.approved) {
      return reply(callback, { ok: false, error: "Wait for referee approval." });
    }

    if (room.status !== "playing") {
      return reply(callback, { ok: false, error: "The session is not active." });
    }

    if (room.buzzer) {
      return reply(callback, {
        ok: false,
        error: "A buzzer question is currently in progress."
      });
    }

    if (room.currentTurnPlayerId !== player.id) {
      return reply(callback, {
        ok: false,
        error: "It is not your turn yet. Please wait."
      });
    }

    if (player.currentQuestion !== null) {
      return reply(callback, {
        ok: false,
        error: "Submit your current question before choosing another."
      });
    }

    const index = Number(data.index);

    if (!Number.isInteger(index) || index < 0 || index >= room.questions.length) {
      return reply(callback, { ok: false, error: "Invalid question number." });
    }

    const question = room.questions[index];

    if (question.answered || question.buzzerActive) {
      return reply(callback, {
        ok: false,
        error: "This question is no longer available."
      });
    }

    if (question.claimedBy) {
      return reply(callback, {
        ok: false,
        error: "Another player has already claimed this question."
      });
    }

    question.claimedBy = player.id;
    player.currentQuestion = question.id;
    player.answer = null;
    player.feedback = null;
    player.pickDeadline = Date.now() + room.pickTime * 1000;
    player.status = "Choosing an answer";

    room.current = question.id;
    room.deadline = player.pickDeadline;

    reply(callback, {
      ok: true,
      question: publicQuestion(question)
    });

    emit(room);
  });

  socket.on("player:lock", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player || room.status !== "playing") {
      return reply(callback, { ok: false, error: "Active player not found." });
    }

    if (room.buzzer || room.currentTurnPlayerId !== player.id) {
      return reply(callback, { ok: false, error: "It is not your turn." });
    }

    if (!player.currentQuestion || player.answer) {
      return reply(callback, { ok: false, error: "No answer is waiting to be locked." });
    }

    if (Date.now() >= player.pickDeadline) {
      return reply(callback, { ok: false, error: "Your answer time has expired." });
    }

    const answer = clean(data.answer, 1).toUpperCase();

    if (!["A", "B", "C", "D"].includes(answer)) {
      return reply(callback, { ok: false, error: "Choose A, B, C or D." });
    }

    player.answer = answer;
    player.status = "Answer locked; ready to submit";

    reply(callback, { ok: true });
    emit(room);
  });

  socket.on("player:submit", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player || room.status !== "playing") {
      return reply(callback, { ok: false, error: "Active player not found." });
    }

    if (room.buzzer || room.currentTurnPlayerId !== player.id) {
      return reply(callback, { ok: false, error: "It is not your turn." });
    }

    if (!player.currentQuestion || !player.answer) {
      return reply(callback, {
        ok: false,
        error: "Choose and lock an answer before submitting."
      });
    }

    const question = room.questions.find(
      q => q.id === player.currentQuestion
    );

    if (!question || question.claimedBy !== player.id || question.answered) {
      return reply(callback, {
        ok: false,
        error: "This question is no longer available."
      });
    }

    const feedback = clean(data.feedback, 4000);
    const isCorrect = player.answer === question.correct;

    question.answered = true;

    const submission = {
      id: makeId(),
      playerId: player.id,
      name: player.name,
      questionId: question.id,
      questionIndex: room.questions.indexOf(question),
      question: question.text,
      options: [...question.options],
      answer: player.answer,
      feedback,
      correct: question.correct,
      isCorrect,
      marks: 0,
      submittedAt: Date.now()
    };

    room.submissions.push(submission);
    player.answeredQuestions.push(question.id);
    player.status = "Submitted";

    player.currentQuestion = null;
    player.answer = null;
    player.feedback = null;
    player.pickDeadline = null;

    room.current = null;
    room.deadline = null;

    reply(callback, {
      ok: true,
      submissionId: submission.id,
      feedbackSaved: Boolean(feedback)
    });

    advanceTurn(room, player.id);
  });

  socket.on("player:buzzer:claim", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player || room.status !== "playing") {
      return reply(callback, { ok: false, error: "Active player not found." });
    }

    const buzzer = room.buzzer;

    if (!buzzer || !buzzer.active || buzzer.claimantPlayerId) {
      return reply(callback, {
        ok: false,
        error: "The buzzer is no longer available."
      });
    }

    if (buzzer.deadline && Date.now() >= buzzer.deadline) {
      return reply(callback, {
        ok: false,
        error: "The buzzer time has expired."
      });
    }

    if (
      !player.approved ||
      !player.connected ||
      !buzzer.eligiblePlayerIds.includes(player.id)
    ) {
      return reply(callback, {
        ok: false,
        error: "You are not eligible to claim this buzzer."
      });
    }

    const question = room.questions.find(
      q => q.id === buzzer.questionId
    );

    if (!question || question.answered || !question.buzzerActive) {
      return reply(callback, {
        ok: false,
        error: "This buzzer question is no longer available."
      });
    }

    // The server processes this synchronously; the first valid click wins.
    buzzer.claimantPlayerId = player.id;
    buzzer.deadline = Date.now() + room.pickTime * 1000;

    question.buzzerActive = false;
    question.claimedBy = player.id;

    player.status = "Answering a buzzer question";

    reply(callback, {
      ok: true,
      question: publicQuestion(question),
      deadline: buzzer.deadline
    });

    emit(room);
  });

  socket.on("player:buzzer:submit", (data = {}, callback) => {
    const room = findRoom(data.roomId);
    const player = findPlayer(room, socket);

    if (!room || !player || room.status !== "playing") {
      return reply(callback, { ok: false, error: "Active player not found." });
    }

    const result = resolveBuzzer(room, player, data.answer);
    reply(callback, result);
  });

  socket.on("host:answer:override", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, { ok: false, error: "Referee only." });
    }

    const answer = clean(data.correct, 1).toUpperCase();

    if (!["A", "B", "C", "D"].includes(answer)) {
      return reply(callback, {
        ok: false,
        error: "Correct answer must be A, B, C or D."
      });
    }

    const submission = room.submissions.find(s => s.id === data.submissionId);

    if (!submission) {
      return reply(callback, { ok: false, error: "Submission not found." });
    }

    submission.correct = answer;
    submission.isCorrect = submission.answer === answer;
    submission.answerOverridden = true;

    emit(room);
    reply(callback, { ok: true });
  });

  socket.on("host:mark", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, { ok: false, error: "Referee only." });
    }

    const submission = room.submissions.find(s => s.id === data.submissionId);

    if (!submission) {
      return reply(callback, { ok: false, error: "Submission not found." });
    }

    const marks = Number(data.marks);

    if (!Number.isFinite(marks) || marks < 0 || marks > 100) {
      return reply(callback, {
        ok: false,
        error: "Marks must be between 0 and 100."
      });
    }

    const player = room.players.find(p => p.id === submission.playerId);

    if (!player) {
      return reply(callback, { ok: false, error: "Player not found." });
    }

    const previousMarks = Number(submission.marks || 0);

    submission.marks = marks;
    player.score += marks - previousMarks;

    emit(room);
    reply(callback, { ok: true });
  });

  socket.on("host:end", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!isHost(room, socket)) {
      return reply(callback, { ok: false, error: "Referee only." });
    }

    finishRoom(room);
    reply(callback, { ok: true });
  });

  socket.on("room:resume", (data = {}, callback) => {
    const room = findRoom(data.roomId);

    if (!room) {
      return reply(callback, { ok: false, error: "Room no longer exists." });
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
      room: host ? refereeView(room) : publicView(room)
    });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        emit(room);
      }

      const player = room.players.find(p => p.socketId === socket.id);

      if (player) {
        player.connected = false;
        player.socketId = null;
        player.status = "Disconnected";

        if (room.buzzer && room.buzzer.active) {
          room.buzzer.eligiblePlayerIds =
            room.buzzer.eligiblePlayerIds.filter(id => id !== player.id);

          // A disconnected buzzer claimant remains claimant until timeout.
        }

        emit(room);
      }
    }
  });
});

// SESSION AND ANSWER TIMERS
setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.status !== "playing") continue;

    if (room.sessionDeadline && now >= room.sessionDeadline) {
      finishRoom(room);
      continue;
    }

    // Buzzer phase: close if nobody claims before the deadline.
    if (
      room.buzzer &&
      !room.buzzer.claimantPlayerId &&
      room.buzzer.deadline &&
      now >= room.buzzer.deadline
    ) {
      closeBuzzerQuestion(room, null);
      continue;
    }

    // Buzzer winner: close if their answer time expires.
    if (
      room.buzzer &&
      room.buzzer.claimantPlayerId &&
      room.buzzer.deadline &&
      now >= room.buzzer.deadline
    ) {
      closeBuzzerQuestion(
        room,
        "Buzzer time expired — question closed"
      );
      continue;
    }

    const player = room.players.find(
      p => p.id === room.currentTurnPlayerId
    );

    if (
      !room.buzzer &&
      player &&
      player.currentQuestion &&
      !player.answer &&
      player.pickDeadline &&
      now >= player.pickDeadline
    ) {
      startBuzzer(room, player);
    }
  }
}, 1000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Classroom Arena running on port ${PORT}`);
});
