
"use strict";

const socket = io();
const $ = id => document.getElementById(id);

let room = null;
let role = "";
let playerId = "";
let bank = [];
let activeIndex = null;
let chosen = null;
let locked = false;
let answerTimer = null;
let sessionTimer = null;
let seconds = 0;
let hostToken = "";
let playerToken = "";
let playerName = "";
let cameraStream = null;

const screens = [
  "home", "auth", "setup", "join",
  "refDash", "playerDash", "finished"
];

const sampleQuestions = [
  {
    text: "Which organelle produces most ATP in a eukaryotic cell?",
    options: ["Mitochondrion", "Ribosome", "Golgi apparatus", "Lysosome"],
    correct: "A"
  },
  {
    text: "Which structure regulates movement into and out of a cell?",
    options: ["Cell wall", "Cell membrane", "Nucleolus", "Ribosome"],
    correct: "B"
  }
];

function show(id) {
  screens.forEach(screen => {
    const element = $(screen);
    if (element) element.classList.toggle("hidden", screen !== id);
  });
}

function say(message) {
  const element = $("message");
  if (element) element.textContent = message || "";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function stopTimers() {
  clearInterval(answerTimer);
  clearInterval(sessionTimer);
  answerTimer = null;
  sessionTimer = null;
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }

  const preview = $("cameraPreview");
  if (preview) preview.srcObject = null;

  if ($("cameraStatus")) {
    $("cameraStatus").textContent = "Camera is off.";
  }
}

function getPlayer() {
  return room?.players?.find(player => player.id === playerId);
}

function isApproved(player) {
  return player?.approved === true || player?.status === "approved";
}

function isAnswered(question) {
  return Boolean(question?.answered || question?.status === "answered");
}

function isClaimed(question) {
  return Boolean(
    question?.claimedBy ||
    question?.owner ||
    question?.status === "claimed"
  );
}

function questionIsMine(question) {
  return question?.claimedBy === playerId ||
    question?.owner === playerId;
}

function canPickQuestion(question) {
  const player = getPlayer();

  return Boolean(
    role === "player" &&
    room?.status === "playing" &&
    player &&
    isApproved(player) &&
    player.isCurrentTurn &&
    activeIndex === null &&
    question &&
    !isAnswered(question) &&
    !isClaimed(question)
  );
}

function updateHeader() {
  if ($("headerStatus")) {
    $("headerStatus").textContent = room
      ? `Room ${room.code || ""}`
      : socket.connected ? "Connected" : "Connecting...";
  }
}

function makeQuestion(question) {
  return {
    text: String(question.text || "").trim(),
    options: Array.isArray(question.options)
      ? question.options.slice(0, 4).map(value => String(value || "").trim())
      : ["", "", "", ""],
    correct: String(question.correct || "A").toUpperCase()
  };
}

function validateQuestion(question, index) {
  if (!question.text.trim()) {
    return `Question ${index + 1} needs question text.`;
  }

  if (
    question.options.length !== 4 ||
    question.options.some(option => !option.trim())
  ) {
    return `Question ${index + 1} needs all four answer options.`;
  }

  if (!["A", "B", "C", "D"].includes(question.correct)) {
    return `Question ${index + 1} needs a correct answer from A to D.`;
  }

  return "";
}

function emitWithAck(event, payload, successMessage) {
  socket.emit(event, payload, response => {
    if (!response?.ok) {
      say(response?.error || "The action could not be completed.");
      return;
    }

    if (successMessage) say(successMessage);
  });
}

/* -------------------------------------------------
   HOME AND REFEREE LOGIN
-------------------------------------------------- */

$("refStart")?.addEventListener("click", () => {
  say("");
  show("auth");
});

$("playerStart")?.addEventListener("click", () => {
  say("");
  show("join");
});

function goHome() {
  stopTimers();
  stopCamera();

  room = null;
  role = "";
  playerId = "";
  activeIndex = null;
  chosen = null;
  locked = false;

  say("");
  updateHeader();
  show("home");
}

$("backHome")?.addEventListener("click", goHome);
$("backHome2")?.addEventListener("click", goHome);
$("homeBtn")?.addEventListener("click", goHome);

$("authBtn")?.addEventListener("click", () => {
  // This is only a demonstration gate, not secure authentication.
  if ($("password")?.value !== "1144") {
    say("Incorrect demo password.");
    return;
  }

  bank = sampleQuestions.map(makeQuestion);
  drawBank();
  say("");
  show("setup");
});

/* -------------------------------------------------
   QUESTION BANK
-------------------------------------------------- */

function drawBank() {
  const container = $("bank");
  if (!container) return;

  container.innerHTML = "";

  bank.forEach((question, index) => {
    const entry = document.createElement("div");
    entry.className = "entry";

    entry.innerHTML = `
      <div class="between">
        <b>Question ${index + 1}</b>
        <button type="button" class="secondary remove-question">
          Remove
        </button>
      </div>

      <label>
        Question text
        <textarea class="question-text" rows="2"></textarea>
      </label>

      <div class="grid">
        ${["A", "B", "C", "D"].map((letter, optionIndex) => `
          <label>
            Option ${letter}
            <input class="question-option" data-option="${optionIndex}">
          </label>
        `).join("")}
      </div>

      <label>
        Correct option
        <select class="question-correct">
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
          <option value="D">D</option>
        </select>
      </label>
    `;

    entry.querySelector(".question-text").value = question.text;

    entry.querySelector(".question-text").addEventListener("input", event => {
      question.text = event.target.value;
    });

    entry.querySelectorAll(".question-option").forEach(input => {
      const optionIndex = Number(input.dataset.option);
      input.value = question.options[optionIndex] || "";

      input.addEventListener("input", event => {
        question.options[optionIndex] = event.target.value;
      });
    });

    entry.querySelector(".question-correct").value = question.correct;

    entry.querySelector(".question-correct").addEventListener("change", event => {
      question.correct = event.target.value;
    });

    entry.querySelector(".remove-question").addEventListener("click", () => {
      bank.splice(index, 1);
      drawBank();
    });

    container.appendChild(entry);
  });

  if ($("bankCount")) {
    $("bankCount").textContent = `${bank.length} questions in your bank.`;
  }
}

$("addQuestion")?.addEventListener("click", () => {
  bank.push({
    text: "",
    options: ["", "", "", ""],
    correct: "A"
  });

  drawBank();
});

/* -------------------------------------------------
   QUESTION GENERATION
-------------------------------------------------- */

$("generateQuestions")?.addEventListener("click", () => {
  const status = $("generationStatus");

  if (status) {
    status.textContent =
      "Automatic AI generation is not connected yet. You can add or edit questions in the question bank below.";
  }

  say(
    "The question-generation service has not been connected yet. " +
    "Your selected topic and uploaded material are not processed by this prototype."
  );
});

/* -------------------------------------------------
   CREATE ROOM
-------------------------------------------------- */

$("createRoom")?.addEventListener("click", () => {
  const playerCount = Number($("playerCount")?.value);
  const roomName = $("roomName")?.value.trim();
  const code = $("accessCode")?.value.trim().toUpperCase();

  if (!Number.isInteger(playerCount) || playerCount < 1) {
    say("Enter a valid number of players.");
    return;
  }

  if (!roomName || !code) {
    say("Enter a group name and room access code.");
    return;
  }

  if (bank.length < 1) {
    say("Add at least one question before creating the room.");
    return;
  }

  for (let index = 0; index < bank.length; index++) {
    const error = validateQuestion(bank[index], index);
    if (error) {
      say(error);
      return;
    }
  }

  const payload = {
    name: roomName,
    code,
    playerCount,
    duration: Number($("duration")?.value || 30),
    pickTime: Number($("pickTime")?.value || 60),
    explainTime: Number($("explainTime")?.value || 120),
    autoStart: Boolean($("autoStart")?.checked),
    questions: bank.map(makeQuestion)
  };

  say("Creating your room...");

  socket.emit("room:create", payload, response => {
    if (!response?.ok) {
      say(response?.error || "Unable to create the room.");
      return;
    }

    room = response.room;
    role = "host";
    hostToken = response.hostToken || "";

    if (hostToken) {
      localStorage.setItem("classroomArenaHostToken", hostToken);
      localStorage.setItem("classroomArenaHostRoomId", room.id);
    }

    $("dashName").textContent = room.name || "";
    $("shareCode").textContent = room.code || "";
    $("roomId").textContent = room.id || "";

    updateHeader();
    say("");
    show("refDash");
    renderRoom(room);
  });
});

/* -------------------------------------------------
   PLAYER JOIN AND RESUME
-------------------------------------------------- */

$("joinBtn")?.addEventListener("click", () => {
  playerName = $("playerName")?.value.trim() || "";
  const code = $("joinCode")?.value.trim().toUpperCase() || "";

  if (!playerName || !code) {
    say("Enter your name and the room access code.");
    return;
  }

  if ($("cameraConsent") && !$("cameraConsent").checked) {
    say("Please confirm that you understand the camera requirements before joining.");
    return;
  }

  const savedToken = localStorage.getItem("classroomArenaPlayerToken") || "";

  say("Requesting to join the room...");

  socket.emit("room:join", {
    code,
    name: playerName,
    resumeToken: savedToken || undefined
  }, response => {
    if (!response?.ok) {
      say(response?.error || "Unable to join the room.");
      return;
    }

    room = response.room;
    role = "player";
    playerId = response.playerId;
    playerToken = response.resumeToken || "";

    if (playerToken) {
      localStorage.setItem("classroomArenaPlayerToken", playerToken);
      localStorage.setItem("classroomArenaPlayerRoomCode", code);
      localStorage.setItem("classroomArenaPlayerName", playerName);
    }

    $("playerRoom").textContent = room.name || "";
    $("playerRoomId").textContent = room.id || "";
    $("playerIdentity").textContent = playerName;

    updateHeader();
    say("");
    show("playerDash");
    renderRoom(room);
  });
});

/* -------------------------------------------------
   REFEREE RESUME
-------------------------------------------------- */

function attemptHostResume() {
  const savedRoomId = localStorage.getItem("classroomArenaHostRoomId");
  const savedToken = localStorage.getItem("classroomArenaHostToken");

  if (!savedRoomId || !savedToken) return;

  socket.emit("host:resume", {
    roomId: savedRoomId,
    hostToken: savedToken
  }, response => {
    if (!response?.ok || !response.room) return;

    room = response.room;
    role = "host";
    hostToken = savedToken;

    $("dashName").textContent = room.name || "";
    $("shareCode").textContent = room.code || "";
    $("roomId").textContent = room.id || "";

    updateHeader();
    show("refDash");
    renderRoom(room);
  });
}

/* -------------------------------------------------
   REFEREE ROOM CONTROLS
-------------------------------------------------- */

$("startNow")?.addEventListener("click", () => {
  if (!room) return;

  emitWithAck("host:start", {
    roomId: room.id
  });
});

$("endSession")?.addEventListener("click", () => {
  if (!room) return;

  if (!confirm("Are you sure you want to end this session?")) return;

  emitWithAck("host:end", {
    roomId: room.id
  });
});

window.approvePlayer = player => {
  if (!room) return;

  emitWithAck("host:approve", {
    roomId: room.id,
    playerId: player
  });
};

window.kickPlayer = player => {
  if (!room) return;

  if (!confirm("Remove this player from the room?")) return;

  emitWithAck("host:kick", {
    roomId: room.id,
    playerId: player
  });
};

/* -------------------------------------------------
   REFEREE QUESTION EDITING
-------------------------------------------------- */

function updateRoomQuestionBank() {
  if (!room || role !== "host") return;

  const questions = bank.map(makeQuestion);

  for (let index = 0; index < questions.length; index++) {
    const error = validateQuestion(questions[index], index);
    if (error) {
      say(error);
      return;
    }
  }

  emitWithAck("host:questions:update", {
    roomId: room.id,
    questions
  }, "Question bank updated.");
}

function addQuestionToLiveRoom() {
  if (!room || role !== "host") return;

  const question = {
    text: "New question",
    options: ["Option A", "Option B", "Option C", "Option D"],
    correct: "A"
  };

  emitWithAck("host:question:add", {
    roomId: room.id,
    question
  });
}

window.editRoomQuestion = (index, question) => {
  if (!room || role !== "host") return;

  emitWithAck("host:question:edit", {
    roomId: room.id,
    index,
    question: makeQuestion(question)
  });
};

window.deleteRoomQuestion = index => {
  if (!room || role !== "host") return;

  if (!confirm("Delete this question from the room?")) return;

  emitWithAck("host:question:delete", {
    roomId: room.id,
    index
  });
};

/* -------------------------------------------------
   END SESSION AND HOME
-------------------------------------------------- */

function finishRoom(updatedRoom) {
  stopTimers();
  stopCamera();

  show("finished");

  const players = (updatedRoom.players || [])
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  $("results").innerHTML = players.map((player, index) => `
    <p>
      <b>${index + 1}. ${escapeHTML(player.name)}</b>
      — ${Number(player.score || 0)} points
    </p>
  `).join("") || "<p>No results available.</p>";
}

/* -------------------------------------------------
   ROOM DISPLAY
-------------------------------------------------- */

function renderRoom(updatedRoom) {
  if (!updatedRoom) return;

  room = updatedRoom;
  updateHeader();

  if (room.status === "finished") {
    finishRoom(room);
    return;
  }

  if (role === "host") {
    renderRefereeDashboard();
  } else if (role === "player") {
    renderPlayerDashboard();
  }
}

/* -------------------------------------------------
   REFEREE DASHBOARD
-------------------------------------------------- */

function renderRefereeDashboard() {
  show("refDash");

  $("dashName").textContent = room.name || "";
  $("shareCode").textContent = room.code || "";
  $("roomId").textContent = room.id || "";

  const players = room.players || [];

  $("monitor").innerHTML = players.map(player => {
    const approved = isApproved(player);
    const connection = player.connected ? "Connected" : "Disconnected";

    return `
      <div class="entry">
        <div class="between">
          <b>${escapeHTML(player.name)}</b>
          <b>${Number(player.score || 0)} pts</b>
        </div>

        <p>
          Approval: ${approved ? "Approved" : "Waiting for approval"}
          · Connection: ${connection}
        </p>

        <p>
          Questions answered: ${Number(player.answeredCount || 0)}
        </p>

        ${!approved ? `
          <button onclick="approvePlayer('${escapeHTML(player.id)}')">
            Approve player
          </button>
        ` : ""}

        <button class="secondary" onclick="kickPlayer('${escapeHTML(player.id)}')">
          Remove player
        </button>
      </div>
    `;
  }).join("") || "<p>No players have joined yet.</p>";

  const ready = players.length === Number(room.playerCount) &&
    players.every(isApproved);

  if ($("startNow")) {
    $("startNow").disabled = room.status !== "lobby" || !ready;
  }

  if ($("sessionClock")) {
    $("sessionClock").textContent =
      room.status === "playing" ? "In progress" :
      room.status === "lobby" ? "Waiting for players" :
      room.status;
  }

  renderPlayerProfiles();
  renderMarkingPanel();
  startSessionClock();
}

/* -------------------------------------------------
   REFEREE PLAYER PROFILES
-------------------------------------------------- */

function renderPlayerProfiles() {
  const container = $("playerProfiles");
  if (!container) return;

  container.innerHTML = (room.players || []).map(player => {
    const history = Array.isArray(player.history) ? player.history : [];

    return `
      <div class="entry">
        <div class="between">
          <b>${escapeHTML(player.name)}</b>
          <b>${Number(player.score || 0)} points</b>
        </div>

        <p>
          Connection: ${player.connected ? "Connected" : "Disconnected"}
        </p>

        <p>
          Questions answered: ${Number(player.answeredCount || 0)}
        </p>

        <h3>Activity history</h3>

        ${history.map(item => `
          <div class="entry">
            <b>Question ${Number(item.questionIndex ?? 0) + 1}</b>
            <p>${escapeHTML(item.question || "")}</p>
            <p>Answer: ${escapeHTML(item.answer || "Not submitted")}</p>
            <p>Explanation: ${escapeHTML(item.feedback || "None")}</p>
            <p>Marks: ${Number(item.marks || 0)}</p>
          </div>
        `).join("") || "<p>No activity recorded yet.</p>"}

        <p class="hint">
          Webcam recording is not connected in this version.
        </p>
      </div>
    `;
  }).join("") || "<p>No player profiles yet.</p>";
}

/* -------------------------------------------------
   REFEREE MARKING AND ANSWER OVERRIDES
-------------------------------------------------- */

function renderMarkingPanel() {
  const container = $("marking");
  if (!container) return;

  const submissions = room.submissions || [];

  container.innerHTML = submissions.map(submission => `
    <div class="entry">
      <b>
        ${escapeHTML(submission.name)}
        · Question ${Number(submission.questionIndex) + 1}
      </b>

      <p>${escapeHTML(submission.question)}</p>
      <p>Answer selected: ${escapeHTML(submission.answer || "Not provided")}</p>
      <p>Explanation: ${escapeHTML(submission.feedback || "None")}</p>
      <p>Current result: ${submission.isCorrect ? "Correct" : "Incorrect"}</p>

      <label>
        Marks
        <input
          type="number"
          min="0"
          step="0.5"
          id="marks-${escapeHTML(submission.id)}"
          value="${Number(submission.marks || 0)}"
        >
      </label>

      <label>
        Correct answer override
        <select id="correct-${escapeHTML(submission.id)}">
          ${["A", "B", "C", "D"].map(letter => `
            <option
              value="${letter}"
              ${submission.correct === letter ? "selected" : ""}
            >${letter}</option>
          `).join("")}
        </select>
      </label>

      <div class="actions">
        <button onclick="saveMarks('${escapeHTML(submission.id)}')">
          Save marks
        </button>

        <button class="secondary" onclick="overrideAnswer('${escapeHTML(submission.id)}')">
          Save correct answer
        </button>
      </div>
    </div>
  `).join("") || "<p>No submissions yet.</p>";
}

window.saveMarks = submissionId => {
  if (!room) return;

  const marks = Number($(`marks-${submissionId}`)?.value);

  if (!Number.isFinite(marks) || marks < 0) {
    say("Enter a valid mark.");
    return;
  }

  emitWithAck("host:mark", {
    roomId: room.id,
    submissionId,
    marks
  }, "Marks saved.");
};

window.overrideAnswer = submissionId => {
  if (!room) return;

  const correct = $(`correct-${submissionId}`)?.value;

  if (!["A", "B", "C", "D"].includes(correct)) {
    say("Choose a valid correct answer.");
    return;
  }

  emitWithAck("host:answer:override", {
    roomId: room.id,
    submissionId,
    correct
  }, "Correct answer updated.");
};

/* -------------------------------------------------
   PLAYER DASHBOARD
-------------------------------------------------- */

function renderPlayerDashboard() {
  show("playerDash");

  const player = getPlayer();

  if (!player) {
    $("phase").textContent = "Waiting for player information...";
    return;
  }

  $("playerRoom").textContent = room.name || "";
  $("playerRoomId").textContent = room.id || "";
  $("playerIdentity").textContent = player.name || playerName;

  if (!isApproved(player)) {
    $("phase").textContent =
      "Your request has been sent. Please wait for referee approval.";
  } else if (room.status === "lobby") {
    $("phase").textContent =
      "You have been approved. Waiting for the referee to start.";
  } else if (room.status === "playing" && player.isCurrentTurn) {
    $("phase").textContent =
      "It is your turn. Choose any available question.";
  } else if (room.status === "playing") {
    $("phase").textContent =
      "Please wait. Another player is taking their turn.";
  } else {
    $("phase").textContent = `Session status: ${room.status}`;
  }

  if ($("playerProgress")) {
    $("playerProgress").textContent =
      `Questions answered: ${Number(player.answeredCount || 0)}`;
  }

  if ($("playerQuestionLimit")) {
    $("playerQuestionLimit").textContent =
      "There is no individual question quota. Choose from the available bank when it is your turn.";
  }

  if ($("turnIndicator")) {
    $("turnIndicator").textContent = player.isCurrentTurn
      ? "YOUR TURN"
      : "WAITING FOR YOUR TURN";
  }

  renderQuestionTiles();
  renderLeaderboard();
  startSessionClock();
}

/* -------------------------------------------------
   QUESTION BOARD
-------------------------------------------------- */

function renderQuestionTiles() {
  const container = $("tiles");
  if (!container) return;

  const questions = room.questions || [];

  container.innerHTML = questions.map((question, index) => {
    const answered = isAnswered(question);
    const claimed = isClaimed(question);
    const mine = questionIsMine(question);

    let label = `Question ${index + 1}`;
    let classes = "secondary";
    let disabled = true;

    if (answered) {
      label += " — Answered";
      classes += " answered";
    } else if (claimed && !mine) {
      label += " — Taken";
      classes += " claimed";
    } else if (mine) {
      label += " — Your question";
      classes += " selected";
    } else if (canPickQuestion(question)) {
      disabled = false;
    }

    return `
      <button
        class="${classes}"
        ${disabled ? "disabled" : ""}
        onclick="pickQuestion(${index})"
      >
        ${label}
      </button>
    `;
  }).join("");
}

window.pickQuestion = index => {
  if (!room || activeIndex !== null) return;

  const question = room.questions?.[index];

  if (!canPickQuestion(question)) {
    say("This question is unavailable, or it is not your turn.");
    return;
  }

  say("Claiming question...");

  socket.emit("player:pick", {
    roomId: room.id,
    index
  }, response => {
    if (!response?.ok) {
      say(response?.error || "This question is no longer available.");
      return;
    }

    if (response.room) room = response.room;

    activeIndex = index;
    chosen = null;
    locked = false;
    seconds = Number(room.pickTime || 60);

    say("");
    drawQuestion();
    startAnswerClock();
    renderQuestionTiles();
  });
};

/* -------------------------------------------------
   QUESTION AND ANSWER SCREEN
-------------------------------------------------- */

function drawQuestion() {
  const question = room?.questions?.[activeIndex];
  if (!question || !$("questionArea")) return;

  $("questionArea").innerHTML = `
    <div class="entry">
      <h3>${escapeHTML(question.text)}</h3>

      ${question.options.map((option, index) => `
        <label class="choice">
          <input
            type="radio"
            name="answer"
            value="${"ABCD"[index]}"
            ${locked ? "disabled" : ""}
          >
          ${"ABCD"[index]}. ${escapeHTML(option)}
        </label>
      `).join("")}

      <p id="clock">${seconds}s</p>

      <button id="lock" ${locked ? "disabled" : ""}>
        Lock answer
      </button>

      <div id="explain" class="hidden">
        <label>
          Optional explanation
          <textarea id="feedback" rows="3"
            placeholder="You may explain your answer, or leave this blank."></textarea>
        </label>

        <button id="submit">Submit answer</button>
      </div>
    </div>
  `;

  $("lock").addEventListener("click", lockAnswer);
  $("submit").addEventListener("click", submitAnswer);
}

/* -------------------------------------------------
   ANSWER TIMER
-------------------------------------------------- */

function startAnswerClock() {
  clearInterval(answerTimer);

  answerTimer = setInterval(() => {
    seconds = Math.max(0, seconds - 1);

    if ($("clock")) {
      $("clock").textContent = `${seconds}s`;
    }

    if (seconds <= 0) {
      clearInterval(answerTimer);
      answerTimer = null;

      if (!locked) {
        say("Your answer-selection time has expired. Select and lock an answer if the session still permits it.");
      } else {
        submitAnswer();
      }
    }
  }, 1000);
}

/* -------------------------------------------------
   LOCK ANSWER
-------------------------------------------------- */

function lockAnswer() {
  if (locked || activeIndex === null) return;

  chosen = document.querySelector(
    'input[name="answer"]:checked'
  )?.value;

  if (!chosen) {
    say("Choose an option before locking your answer.");
    return;
  }

  socket.emit("player:lock", {
    roomId: room.id,
    answer: chosen
  }, response => {
    if (!response?.ok) {
      say(response?.error || "Unable to lock your answer.");
      return;
    }

    locked = true;
    clearInterval(answerTimer);

    document.querySelectorAll('input[name="answer"]').forEach(input => {
      input.disabled = true;
    });

    $("lock").disabled = true;
    $("explain").classList.remove("hidden");

    seconds = Number(room.explainTime || 120);

    if ($("clock")) $("clock").textContent = `${seconds}s`;

    say("Answer locked. You may submit now, with or without an explanation.");
    startAnswerClock();
  });
}

/* -------------------------------------------------
   SUBMIT ANSWER
-------------------------------------------------- */

function submitAnswer() {
  if (activeIndex === null || !locked) return;

  clearInterval(answerTimer);
  answerTimer = null;

  const feedback = $("feedback")?.value || "";

  socket.emit("player:submit", {
    roomId: room.id,
    feedback
  }, response => {
    if (!response?.ok) {
      say(response?.error || "Unable to submit your answer.");
      return;
    }

    activeIndex = null;
    chosen = null;
    locked = false;

    if ($("questionArea")) {
      $("questionArea").innerHTML =
        "<p>Your answer has been submitted and locked.</p>";
    }

    say("Answer submitted successfully. Please wait for your next turn.");
  });
}

/* -------------------------------------------------
   LEADERBOARD
-------------------------------------------------- */

function renderLeaderboard() {
  const container = $("leaderboard");
  if (!container) return;

  const players = (room.players || [])
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  container.innerHTML = players.map((player, index) => `
    <div class="player">
      <span>
        ${index + 1}. ${escapeHTML(player.name)}
        ${player.isCurrentTurn ? " — Playing now" : ""}
      </span>
      <b class="score">${Number(player.score || 0)} pts</b>
    </div>
  `).join("") || "<p>No scores yet.</p>";
}

/* -------------------------------------------------
   SESSION TIMER
-------------------------------------------------- */

function startSessionClock() {
  clearInterval(sessionTimer);
  sessionTimer = null;

  if (!room?.startedAt || !room?.duration) return;

  const update = () => {
    const startedAt = Number(room.startedAt);
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const remaining = Math.max(0, Number(room.duration) * 60 - elapsed);

    const minutes = Math.floor(remaining / 60);
    const secondsLeft = remaining % 60;
    const display = `${minutes}:${String(secondsLeft).padStart(2, "0")}`;

    if ($("sessionClock")) $("sessionClock").textContent = display;
  };

  update();
  sessionTimer = setInterval(update, 1000);
}

/* -------------------------------------------------
   CAMERA PREVIEW
-------------------------------------------------- */

async function startCameraPreview() {
  if (!navigator.mediaDevices?.getUserMedia) {
    if ($("cameraStatus")) {
      $("cameraStatus").textContent =
        "Camera preview is not supported by this browser.";
    }
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    const preview = $("cameraPreview");

    if (preview) {
      preview.srcObject = cameraStream;
      preview.muted = true;
      await preview.play().catch(() => {});
    }

    if ($("cameraStatus")) {
      $("cameraStatus").textContent =
        "Camera preview is active. This version does not record or upload video.";
    }
  } catch (error) {
    if ($("cameraStatus")) {
      $("cameraStatus").textContent =
        "Camera access was not granted or is unavailable.";
    }
  }
}

/* -------------------------------------------------
   LIVE SERVER UPDATES
-------------------------------------------------- */

socket.on("room:update", updatedRoom => {
  if (!room || updatedRoom.id !== room.id) return;

  room = updatedRoom;

  if (role === "player" && activeIndex !== null) {
    const question = room.questions?.[activeIndex];

    if (!question || isAnswered(question)) {
      activeIndex = null;
      chosen = null;
      locked = false;
      clearInterval(answerTimer);

      if ($("questionArea")) {
        $("questionArea").innerHTML =
          "<p>This question has been submitted and is now unavailable.</p>";
      }
    }
  }

  renderRoom(room);
});

socket.on("host:update", updatedRoom => {
  if (!room || updatedRoom.id !== room.id || role !== "host") return;

  room = updatedRoom;
  renderRoom(room);
});

/* -------------------------------------------------
   CONNECTION AND RECONNECTION
-------------------------------------------------- */

socket.on("connect", () => {
  updateHeader();

  if (room) {
    if (role === "host") {
      attemptHostResume();
    }
    return;
  }

  attemptHostResume();
});

socket.on("disconnect", () => {
  if ($("headerStatus")) {
    $("headerStatus").textContent = "Connection lost — reconnecting...";
  }

  say("Your connection was interrupted. The room may still be active.");
});

socket.on("connect_error", () => {
  say("Unable to connect to the game server. Check your internet connection.");
});

/* -------------------------------------------------
   INITIAL DISPLAY
-------------------------------------------------- */

if ($("generationStatus")) {
  $("generationStatus").textContent =
    "AI question generation is not connected yet.";
}

if ($("bankCount")) {
  $("bankCount").textContent = `${bank.length} questions in your bank.`;
}

updateHeader();
