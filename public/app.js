const socket = io();
const $ = id => document.getElementById(id);

let room = null;
let role = "";
let playerId = "";
let bank = [];
let activeIndex = null;
let chosen = null;
let timer = null;
let seconds = 0;
let locked = false;
let sessionTimer = null;

const screens = [
  "home", "auth", "setup", "join",
  "refDash", "playerDash", "finished"
];

const sample = [
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
  $("message").textContent = message || "";
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
  clearInterval(timer);
  clearInterval(sessionTimer);
  timer = null;
  sessionTimer = null;
}

function getPlayer() {
  return room?.players?.find(player => player.id === playerId);
}

function getQuestionLimit() {
  if (Number.isInteger(Number(room?.perPlayer))) {
    return Number(room.perPlayer);
  }

  const total = Number(room?.totalQuestions ?? room?.questions?.length ?? 0);
  const players = Number(room?.playerCount ?? 0);

  return players > 0 ? Math.floor(total / players) : 0;
}

function getAnsweredCount() {
  const player = getPlayer();

  if (!player) return 0;

  if (Array.isArray(player.answeredQuestions)) {
    return player.answeredQuestions.length;
  }

  if (Array.isArray(player.answered)) {
    return player.answered.length;
  }

  return Number(player.answeredCount ?? 0);
}

function questionIsAnswered(question) {
  return Boolean(
    question.answered ||
    question.status === "answered"
  );
}

function questionIsClaimed(question) {
  return Boolean(
    question.claimedBy ||
    question.owner ||
    question.status === "claimed"
  );
}

function questionClaimant(question) {
  return question.claimedBy || question.owner || null;
}

function questionIsMine(question) {
  return questionClaimant(question) === playerId;
}

function canPickQuestion(question) {
  if (role !== "player") return false;
  if (room?.status !== "playing") return false;
  if (activeIndex !== null) return false;
  if (questionIsAnswered(question)) return false;
  if (questionIsClaimed(question)) return false;

  return getAnsweredCount() < getQuestionLimit();
}

/* -------------------------------------------------
   HOME AND REFEREE AUTHENTICATION
-------------------------------------------------- */

$("refStart").onclick = () => {
  say("");
  show("auth");
};

$("playerStart").onclick = () => {
  say("");
  show("join");
};

$("backHome").onclick = $("backHome2").onclick = () => {
  say("");
  show("home");
};

$("authBtn").onclick = () => {
  if ($("password").value !== "1144") {
    return say("Incorrect demo password.");
  }

  bank = sample.map(question => ({
    ...question,
    options: [...question.options]
  }));

  drawBank();
  say("");
  show("setup");
};

/* -------------------------------------------------
   QUESTION BANK EDITING
-------------------------------------------------- */

function drawBank() {
  $("bank").innerHTML = "";

  bank.forEach((question, index) => {
    const entry = document.createElement("div");
    entry.className = "entry";

    entry.innerHTML = `
      <label>
        Question ${index + 1}
        <textarea class="question-text" rows="2"></textarea>
      </label>

      <div class="grid">
        ${question.options.map((option, optionIndex) => `
          <label>
            Option ${String.fromCharCode(65 + optionIndex)}
            <input class="question-option" data-option="${optionIndex}">
          </label>
        `).join("")}
      </div>

      <label>
        Correct option (A-D)
        <input class="question-correct" maxlength="1">
      </label>

      <button type="button" class="secondary remove-question">
        Remove question
      </button>
    `;

    entry.querySelector(".question-text").value = question.text;

    entry.querySelectorAll(".question-option").forEach(input => {
      const optionIndex = Number(input.dataset.option);
      input.value = question.options[optionIndex] || "";

      input.oninput = event => {
        question.options[optionIndex] = event.target.value;
      };
    });

    entry.querySelector(".question-text").oninput = event => {
      question.text = event.target.value;
    };

    const correctInput = entry.querySelector(".question-correct");
    correctInput.value = question.correct || "A";

    correctInput.oninput = event => {
      question.correct = event.target.value.toUpperCase();
    };

    entry.querySelector(".remove-question").onclick = () => {
      bank.splice(index, 1);
      drawBank();
      updateQuestionDistribution();
    };

    $("bank").appendChild(entry);
  });

  updateQuestionDistribution();
}

$("addQuestion").onclick = () => {
  bank.push({
    text: "",
    options: ["", "", "", ""],
    correct: "A"
  });

  drawBank();
};

/* -------------------------------------------------
   QUESTION DISTRIBUTION
-------------------------------------------------- */

function updateQuestionDistribution() {
  const playerCount = Number($("playerCount").value);
  const totalQuestions = Number($("totalQuestions").value);

  const display = $("questionDistribution");

  if (!display) return;

  if (
    !Number.isInteger(playerCount) ||
    !Number.isInteger(totalQuestions) ||
    playerCount < 1 ||
    totalQuestions < 1
  ) {
    display.textContent = "Enter a valid student count and question total.";
    return;
  }

  if (totalQuestions % playerCount !== 0) {
    display.textContent =
      `${totalQuestions} questions cannot be divided equally among ` +
      `${playerCount} students. Please adjust the total.`;
    return;
  }

  const limit = totalQuestions / playerCount;

  display.textContent =
    `Each student can answer a maximum of ${limit} questions. ` +
    `All students will see the full question bank and may choose ` +
    `available questions in any order.`;
}

$("playerCount").addEventListener("input", updateQuestionDistribution);
$("totalQuestions").addEventListener("input", updateQuestionDistribution);

/* -------------------------------------------------
   CREATE ROOM
-------------------------------------------------- */

$("createRoom").onclick = () => {
  const playerCount = Number($("playerCount").value);
  const totalQuestions = Number($("totalQuestions").value);

  if (!Number.isInteger(playerCount) || playerCount < 1) {
    return say("Enter a valid number of students.");
  }

  if (!Number.isInteger(totalQuestions) || totalQuestions < 1) {
    return say("Enter a valid total number of questions.");
  }

  if (totalQuestions % playerCount !== 0) {
    return say("The total number of questions must divide evenly among the students.");
  }

  if (bank.length !== totalQuestions) {
    return say(
      `Your question bank contains ${bank.length} questions. ` +
      `Please add or remove questions until it contains exactly ${totalQuestions}.`
    );
  }

  for (let i = 0; i < bank.length; i++) {
    const question = bank[i];

    if (!question.text.trim()) {
      return say(`Question ${i + 1} needs question text.`);
    }

    if (question.options.length !== 4 || question.options.some(option => !option.trim())) {
      return say(`Question ${i + 1} needs all four answer options.`);
    }

    if (!["A", "B", "C", "D"].includes(question.correct)) {
      return say(`Question ${i + 1} needs a correct answer from A to D.`);
    }
  }

  const payload = {
    name: $("roomName").value.trim(),
    code: $("accessCode").value.trim().toUpperCase(),
    playerCount,
    totalQuestions,
    perPlayer: totalQuestions / playerCount,
    duration: Number($("duration").value),
    pickTime: Number($("pickTime").value),
    explainTime: Number($("explainTime").value),
    autoStart: $("autoStart").checked,
    questions: bank.map(question => ({
      text: question.text.trim(),
      options: question.options.map(option => option.trim()),
      correct: question.correct
    }))
  };

  if (!payload.name || !payload.code) {
    return say("Enter a group name and player access code.");
  }

  say("Creating your room...");

  socket.emit("room:create", payload, response => {
    if (!response?.ok) {
      return say(response?.error || "Unable to create the room.");
    }

    room = response.room;
    role = "host";

    $("headerStatus").textContent = "Room " + room.code;
    $("dashName").textContent = room.name;
    $("shareCode").textContent = room.code;
    $("roomId").textContent = room.id;

    say("");
    show("refDash");
    renderRoom(room);
  });
};

/* -------------------------------------------------
   PLAYER JOIN AND RESUME
-------------------------------------------------- */

$("joinBtn").onclick = () => {
  const name = $("playerName").value.trim();
  const code = $("joinCode").value.trim().toUpperCase();

  if (!name || !code) {
    return say("Enter your name and the room access code.");
  }

  say("Requesting to join the room...");

  socket.emit("room:join", { code, name }, response => {
    if (!response?.ok) {
      return say(response?.error || "Unable to join the room.");
    }

    room = response.room;
    role = "player";
    playerId = response.playerId;

    $("playerRoom").textContent = room.name;
    $("playerRoomId").textContent = room.id;
    $("playerIdentity").textContent = name;

    $("headerStatus").textContent = "Room " + room.code;

    say("");
    show("playerDash");
    renderRoom(room);
  });
};

/* -------------------------------------------------
   REFEREE CONTROLS
-------------------------------------------------- */

$("endSession").onclick = () => {
  if (!room) return;

  if (!confirm("Are you sure you want to end this session?")) return;

  socket.emit("host:end", { roomId: room.id }, response => {
    if (!response?.ok) {
      return say(response?.error || "Unable to end the session.");
    }
  });
};

if ($("startNow")) {
  $("startNow").onclick = () => {
    if (!room) return;

    socket.emit("host:start", { roomId: room.id }, response => {
      if (!response?.ok) {
        say(response?.error || "The session could not be started.");
      }
    });
  };
}

$("homeBtn").onclick = () => {
  stopTimers();
  room = null;
  role = "";
  playerId = "";
  activeIndex = null;
  show("home");
};

/* -------------------------------------------------
   REFEREE PLAYER APPROVAL AND KICKING
-------------------------------------------------- */

window.approvePlayer = player => {
  if (!room) return;

  socket.emit("host:approve", {
    roomId: room.id,
    playerId: player
  }, response => {
    if (!response?.ok) {
      say(response?.error || "Unable to approve player.");
    }
  });
};

window.kickPlayer = player => {
  if (!room) return;

  if (!confirm("Remove this player from the room?")) return;

  socket.emit("host:kick", {
    roomId: room.id,
    playerId: player
  }, response => {
    if (!response?.ok) {
      say(response?.error || "Unable to remove player.");
    }
  });
};

/* -------------------------------------------------
   ROOM DISPLAY
-------------------------------------------------- */

function renderRoom(updatedRoom) {
  if (!updatedRoom) return;

  room = updatedRoom;

  if (room.status === "finished") {
    stopTimers();
    show("finished");

    $("results").innerHTML = (room.players || [])
      .slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map(player => `
        <p>
          ${escapeHTML(player.name)} —
          ${Number(player.score || 0)} points
        </p>
      `)
      .join("");

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

  $("dashName").textContent = room.name;
  $("shareCode").textContent = room.code;
  $("roomId").textContent = room.id;

  const players = room.players || [];

  $("monitor").innerHTML = players.map(player => {
    const approved = player.approved === true || player.status === "approved";

    return `
      <div class="entry">
        <b>${escapeHTML(player.name)}</b>

        <span class="score">
          ${Number(player.score || 0)} pts
        </span>

        <p>
          Approval: ${approved ? "Approved" : "Waiting for approval"}
          · Connection: ${escapeHTML(player.connection || player.online || "Unknown")}
        </p>

        <p>
          Questions answered:
          ${Number(player.answeredCount || player.answered || 0)}
          / ${getQuestionLimit()}
        </p>

        ${!approved ? `
          <button onclick="approvePlayer('${player.id}')">
            Approve player
          </button>
        ` : ""}

        <button class="secondary" onclick="kickPlayer('${player.id}')">
          Remove player
        </button>
      </div>
    `;
  }).join("") || "<p>No players have joined yet.</p>";

  const ready =
    players.length === Number(room.playerCount) &&
    players.every(player =>
      player.approved === true || player.status === "approved"
    );

  if ($("startNow")) {
    $("startNow").disabled =
      room.status !== "lobby" || !ready;
  }

  $("sessionClock").textContent =
    room.status === "playing"
      ? "In progress"
      : room.status === "lobby"
        ? "Waiting for players"
        : room.status;

  renderMarkingPanel();
}

/* -------------------------------------------------
   REFEREE MARKING PANEL
-------------------------------------------------- */

function renderMarkingPanel() {
  const submissions = room.submissions || [];

  $("marking").innerHTML = submissions.map((submission, index) => `
    <div class="entry">
      <b>
        ${escapeHTML(submission.name)}
        · Question ${Number(submission.questionIndex) + 1}
      </b>

      <p>${escapeHTML(submission.question)}</p>

      <p>
        Answer:
        ${escapeHTML(submission.answer || "Not provided")}
      </p>

      <p>
        Explanation:
        ${escapeHTML(submission.feedback || "None")}
      </p>

      <label>
        Marks
        <input
          id="mark${index}"
          type="number"
          min="0"
          value="${Number(submission.marks || 0)}"
        >
      </label>

      <button onclick="markPlayer('${submission.playerId}', ${index})">
        Save marks
      </button>
    </div>
  `).join("") || "<p>No submissions yet.</p>";
}

window.markPlayer = (id, index) => {
  if (!room) return;

  const marks = Number($("mark" + index).value);

  if (!Number.isFinite(marks) || marks < 0) {
    return say("Enter a valid mark.");
  }

  socket.emit("host:mark", {
    roomId: room.id,
    playerId: id,
    marks
  }, response => {
    if (!response?.ok) {
      say(response?.error || "Unable to save marks.");
    }
  });
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

  const limit = getQuestionLimit();
  const answered = getAnsweredCount();

  $("playerRoom").textContent = room.name;
  $("playerQuestionLimit").textContent =
    `Your maximum: ${limit} questions. Answered: ${answered}/${limit}.`;

  const approved =
    player.approved === true || player.status === "approved";

  if (!approved) {
    $("phase").textContent =
      "Your request has been sent. Please wait for the referee to approve you.";
  } else if (room.status === "lobby") {
    $("phase").textContent =
      "You have been approved. Waiting for the referee to start the session.";
  } else if (room.status === "playing") {
    $("phase").textContent =
      "Session is active. Choose any available question.";
  } else {
    $("phase").textContent = "Session status: " + room.status;
  }

  renderQuestionTiles();
  renderLeaderboard();
}

/* -------------------------------------------------
   FULL QUESTION BANK FOR EVERY PLAYER
-------------------------------------------------- */

function renderQuestionTiles() {
  const questions = room.questions || [];

  $("tiles").innerHTML = questions.map((question, index) => {
    const answered = questionIsAnswered(question);
    const claimed = questionIsClaimed(question);
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

/* -------------------------------------------------
   LEADERBOARD
-------------------------------------------------- */

function renderLeaderboard() {
  const players = (room.players || [])
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  $("leaderboard").innerHTML = players.map((player, index) => `
    <p>
      ${index + 1}. ${escapeHTML(player.name)}
      <b class="score">${Number(player.score || 0)} pts</b>
    </p>
  `).join("") || "<p>No scores yet.</p>";
}

/* -------------------------------------------------
   PICK A QUESTION
-------------------------------------------------- */

window.pickQuestion = index => {
  if (!room || activeIndex !== null) return;

  const question = room.questions[index];

  if (!question) return;

  if (!canPickQuestion(question)) {
    return say("This question is unavailable, or you have reached your question limit.");
  }

  activeIndex = index;
  chosen = null;
  locked = false;

  say("Claiming question...");

  socket.emit("player:pick", {
    roomId: room.id,
    index
  }, response => {
    if (!response?.ok) {
      activeIndex = null;
      say(response?.error || "This question is no longer available.");
      renderRoom(room);
      return;
    }

    if (response.room) room = response.room;

    seconds = Number(room.pickTime || 60);
    say("");
    drawQuestion();
    startClock();
  });
};

/* -------------------------------------------------
   QUESTION AND ANSWER SCREEN
-------------------------------------------------- */

function drawQuestion() {
  const question = room.questions[activeIndex];

  if (!question) return;

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
          <textarea id="feedback" rows="3"></textarea>
        </label>

        <button id="submit">Submit answer</button>
      </div>
    </div>
  `;

  $("lock").onclick = lockAnswer;
  $("submit").onclick = submitAnswer;
}

/* -------------------------------------------------
   ANSWER SELECTION TIMER
-------------------------------------------------- */

function startClock() {
  clearInterval(timer);

  timer = setInterval(() => {
    seconds--;

    const clock = $("clock");

    if (clock) {
      clock.textContent = `${seconds}s`;
    }

    if (seconds <= 0) {
      clearInterval(timer);

      if (!locked) {
        lockAnswer(true);
      } else {
        submitAnswer();
      }
    }
  }, 1000);
}

/* -------------------------------------------------
   LOCK ANSWER
-------------------------------------------------- */

function lockAnswer(timeExpired = false) {
  if (locked || activeIndex === null) return;

  chosen = document.querySelector(
    'input[name="answer"]:checked'
  )?.value;

  if (!chosen && !timeExpired) {
    return say("Choose an option first.");
  }

  if (!chosen && timeExpired) {
    return say("Your selection time expired without an answer.");
  }

  socket.emit("player:lock", {
    roomId: room.id,
    answer: chosen,
    index: activeIndex
  }, response => {
    if (!response?.ok) {
      return say(response?.error || "Unable to lock your answer.");
    }

    locked = true;
    clearInterval(timer);

    $("explain").classList.remove("hidden");
    $("lock").disabled = true;

    document.querySelectorAll('input[name="answer"]').forEach(input => {
      input.disabled = true;
    });

    seconds = Number(room.explainTime || 120);
    $("clock").textContent = `${seconds}s`;

    startClock();
  });
}

/* -------------------------------------------------
   SUBMIT FINAL ANSWER
-------------------------------------------------- */

function submitAnswer() {
  if (activeIndex === null) return;

  clearInterval(timer);

  socket.emit("player:submit", {
    roomId: room.id,
    feedback: $("feedback")?.value || ""
  }, response => {
    if (!response?.ok) {
      return say(response?.error || "Unable to submit your answer.");
    }

    activeIndex = null;
    chosen = null;
    locked = false;

    $("questionArea").innerHTML =
      "<p>Your answer has been submitted and locked.</p>";

    say("Answer submitted successfully.");

    socket.emit("room:resume", {
      roomId: room.id
    }, result => {
      if (result?.ok) {
        room = result.room;
        renderRoom(room);
      }
    });
  });
}

/* -------------------------------------------------
   SESSION TIMER DISPLAY
-------------------------------------------------- */

function startSessionClock() {
  clearInterval(sessionTimer);

  if (!room?.startedAt || !room?.duration) return;

  sessionTimer = setInterval(() => {
    const elapsed = Math.floor(
      (Date.now() - Number(room.startedAt)) / 1000
    );

    const remaining = Math.max(
      0,
      Number(room.duration) * 60 - elapsed
    );

    const minutes = Math.floor(remaining / 60);
    const secondsLeft = remaining % 60;

    const display =
      `${minutes}:${String(secondsLeft).padStart(2, "0")}`;

    if ($("sessionClock")) {
      $("sessionClock").textContent = display;
    }

    if (remaining <= 0) {
      clearInterval(sessionTimer);
    }
  }, 1000);
}

/* -------------------------------------------------
   LIVE ROOM UPDATES
-------------------------------------------------- */

socket.on("room:update", updatedRoom => {
  if (!room || updatedRoom.id !== room.id) return;

  const previousQuestion = activeIndex;

  room = updatedRoom;

  if (role === "player" && previousQuestion !== null) {
    const question = room.questions[previousQuestion];

    if (!question || questionIsAnswered(question)) {
      activeIndex = null;
      locked = false;
      clearInterval(timer);

      $("questionArea").innerHTML =
        "<p>This question has been submitted and is now locked.</p>";
    }
  }

  renderRoom(room);
});

/* -------------------------------------------------
   CONNECTION STATUS
-------------------------------------------------- */

socket.on("connect", () => {
  $("headerStatus").textContent =
    room ? "Reconnecting..." : "Connected";
});

socket.on("disconnect", () => {
  $("headerStatus").textContent = "Connection lost — reconnecting...";
  say("Your connection was interrupted. Your session may still be active.");
});

socket.on("connect_error", () => {
  say("Unable to connect to the game server. Please check your connection.");
});

/* -------------------------------------------------
   INITIAL DISPLAY
-------------------------------------------------- */

updateQuestionDistribution();
