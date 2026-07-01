const $ = (selector) => document.querySelector(selector);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const STORAGE_KEY = "bingo-connect-room-state-v1";
const DEMO_STORAGE_KEY = "bingo-connect-stable-demo-v1";

const BINGO_COLUMNS = [
  { letter: "B", from: 1, to: 15 },
  { letter: "I", from: 16, to: 30 },
  { letter: "N", from: 31, to: 45 },
  { letter: "G", from: 46, to: 60 },
  { letter: "O", from: 61, to: 75 },
];

const STATUS_LABELS = {
  reserved: "En espera",
  paid: "Activo",
  "in-game": "En juego",
  winner: "Ganador",
};

const state = {
  roomCode: "BINGO-4821",
  round: 58,
  pattern: null,
  players: [],
  tickets: [],
  drawn: [],
};

let selectedPlayerId = null;

function getBall(number) {
  const value = Number(number);
  const column = BINGO_COLUMNS.find((item) => value >= item.from && value <= item.to);
  return column ? { letter: column.letter, number: value, label: `${column.letter}-${value}` } : null;
}

function ballHtml(number) {
  const ball = getBall(number);
  if (!ball) return "--";
  return `<span class="ball-letter">${ball.letter}</span><strong>${ball.number}</strong>`;
}

function ticketShort(id) {
  return String(id).padStart(3, "0");
}

function ticketCode(id) {
  return `R${state.round}-C${ticketShort(id)}`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1900);
}

function getTicket(id) {
  return state.tickets.find((ticket) => ticket.id === Number(id));
}

function getPlayer(id) {
  return state.players.find((player) => player.id === id);
}

function stableRandom(seed) {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function stableShuffle(items, seed) {
  const random = stableRandom(seed);
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function normalizeMarks(marks) {
  return new Set(Array.isArray(marks) ? marks : ["FREE"]);
}

function createBingoTicket(id, ownerId) {
  const columns = {};
  BINGO_COLUMNS.forEach(({ letter, from, to }, columnIndex) => {
    columns[letter] = stableShuffle(range(from, to), id * 97 + columnIndex * 31).slice(0, 5).sort((a, b) => a - b);
  });
  return {
    id,
    code: ticketCode(id),
    columns,
    status: "paid",
    ownerId,
    manualMarks: new Set(["FREE"]),
    paidAmount: 0,
  };
}

function createDemoSnapshot() {
  const players = [
    { id: "demo-jesus", name: "Jesus Parra", document: "1001", tickets: [], paid: true, totalPaid: 0 },
    { id: "demo-laura", name: "Laura Gomez", document: "1002", tickets: [], paid: true, totalPaid: 0 },
    { id: "demo-carlos", name: "Carlos Ruiz", document: "4481", tickets: [], paid: true, totalPaid: 0 },
  ];
  const tickets = [];
  let nextTicketId = 15;
  [3, 1, 5].forEach((quantity, playerIndex) => {
    for (let index = 0; index < quantity; index += 1) {
      const ticket = createBingoTicket(nextTicketId, players[playerIndex].id);
      tickets.push({ ...ticket, manualMarks: Array.from(ticket.manualMarks) });
      players[playerIndex].tickets.push(ticket.id);
      nextTicketId += 1;
    }
  });
  return { roomCode: state.roomCode, round: state.round, pattern: null, players, tickets, drawn: [] };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.players) || !Array.isArray(snapshot.tickets)) return false;
  state.roomCode = snapshot.roomCode || state.roomCode;
  state.round = Number(snapshot.round) || state.round;
  state.pattern = snapshot.pattern || null;
  state.players = snapshot.players;
  state.tickets = snapshot.tickets.map((ticket) => ({
    ...ticket,
    manualMarks: normalizeMarks(ticket.manualMarks),
  }));
  state.drawn = snapshot.drawn || [];
  return true;
}

async function loadSnapshot() {
  try {
    const response = await fetch(`/api/state?ts=${Date.now()}`, { cache: "no-store" });
    if (response.ok) {
      const snapshot = await response.json();
      if (normalizeSnapshot(snapshot)) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
        } catch (error) {}
        return;
      }
    }
  } catch (error) {}

  try {
    if (normalizeSnapshot(JSON.parse(localStorage.getItem(STORAGE_KEY)))) return;
  } catch (error) {}

  try {
    if (normalizeSnapshot(JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY)))) return;
  } catch (error) {}

  if (state.players.length && state.tickets.length) return;

  const demoSnapshot = createDemoSnapshot();
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(demoSnapshot));
  } catch (error) {}
  normalizeSnapshot(demoSnapshot);
}

function renderPlayerList() {
  const list = $("#playerOnlyList");
  const players = state.players.filter((player) => player.tickets.length);
  if (!players.length) {
    list.innerHTML = `<div class="inspector-empty">Todavia no hay jugadores registrados.</div>`;
    return;
  }
  list.innerHTML = players.map((player) => `
    <button class="access-player ${selectedPlayerId === player.id ? "selected" : ""}" data-access-player="${player.id}">
      <strong>${player.name}</strong>
      <span>${player.tickets.length} ${player.tickets.length === 1 ? "carton" : "cartones"}</span>
    </button>
  `).join("");
}

function renderTicketCard(ticket) {
  const owner = getPlayer(ticket.ownerId);
  const rows = range(0, 4).map((row) => {
    const cells = BINGO_COLUMNS.map(({ letter }) => {
      if (letter === "N" && row === 2) return `<span class="cell free drawn">LIBRE</span>`;
      const number = ticket.columns[letter][row];
      const drawn = state.drawn.includes(number);
      return `<span class="cell ${drawn ? "drawn" : ""}">${number}</span>`;
    }).join("");
    return `<div class="ticket-row">${cells}</div>`;
  }).join("");

  return `
    <article class="ticket-card">
      <div class="ticket-owner">
        <strong>${owner?.name || "Sin jugador"}</strong>
        <span>Carton ${ticketShort(ticket.id)} - ${statusLabel(ticket.status)}</span>
      </div>
      <div class="bingo-header">${BINGO_COLUMNS.map(({ letter }) => `<span>${letter}</span>`).join("")}</div>
      <div class="ticket-grid">${rows}</div>
    </article>
  `;
}

function renderSelectedPlayer() {
  const player = getPlayer(selectedPlayerId);
  const selectPanel = $("#playerOnlySelect");
  const panel = $("#playerOnlyCardsPanel");
  $("#playerOnlyRoom").textContent = state.roomCode;
  $("#playerOnlyPhoneRoom").textContent = state.roomCode;
  $("#playerOnlyRound").textContent = `Ronda ${state.round}`;
  $("#playerOnlyPattern").textContent = state.pattern?.label || "Sin seleccionar";
  $("#playerOnlyHistory").innerHTML = state.drawn.slice(-24).map((number) => `<span class="history-ball">${ballHtml(number)}</span>`).join("");

  if (!player) {
    selectedPlayerId = null;
    selectPanel.classList.remove("hidden");
    panel.classList.remove("show");
    $("#playerOnlyName").textContent = "Sin jugador seleccionado";
    $("#playerOnlyTotal").textContent = "0";
    $("#playerOnlyState").textContent = "Sin cartones";
    $("#playerOnlyState").className = "status-chip pending";
    $("#playerOnlyTickets").innerHTML = "";
    return;
  }

  const tickets = player.tickets.map(getTicket).filter(Boolean);
  const activeCount = tickets.filter((ticket) => ["paid", "in-game", "winner"].includes(ticket.status)).length;
  selectPanel.classList.add("hidden");
  panel.classList.add("show");
  $("#playerOnlyName").textContent = player.name;
  $("#playerOnlyTotal").textContent = String(tickets.length);
  $("#playerOnlyState").textContent = activeCount ? "Activo" : "Sin cartones";
  $("#playerOnlyState").className = `status-chip ${activeCount ? "ok" : "pending"}`;
  $("#playerOnlyTickets").innerHTML = tickets
    .map(renderTicketCard)
    .join("");
}

function renderAll() {
  renderPlayerList();
  renderSelectedPlayer();
}

function bindEvents() {
  document.body.addEventListener("click", (event) => {
    const playerButton = event.target.closest("[data-access-player]");
    if (!playerButton) return;
    selectedPlayerId = playerButton.dataset.accessPlayer;
    renderAll();
    window.scrollTo({ top: $("#playerOnlyCardsPanel").offsetTop - 12, behavior: "smooth" });
  });

  $("#playerOnlyChange").addEventListener("click", () => {
    selectedPlayerId = null;
    renderAll();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#playerOnlyClaim").addEventListener("click", () => {
    const player = getPlayer(selectedPlayerId);
    if (!player) return;
    const hasWinningTicket = player.tickets
      .map(getTicket)
      .filter(Boolean)
      .some((ticket) => ticket.status === "winner");
    showToast(hasWinningTicket ? "Bingo registrado" : "El servidor valida tu carton automaticamente");
  });
}

async function refresh() {
  await loadSnapshot();
  renderAll();
}

bindEvents();
refresh();
window.setInterval(refresh, 2500);
