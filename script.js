const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const shuffle = (items) => [...items].sort(() => Math.random() - 0.5);
const pesos = (value) => `$ ${value.toLocaleString("es-CO")}`;
const STATUS_LABELS = {
  reserved: "En espera",
  paid: "Activo",
  "in-game": "En juego",
  winner: "Ganador",
};
const LAN_FALLBACK_HOST = "192.168.1.2";
const STORAGE_KEY = "bingo-connect-room-state-v1";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => registration.unregister());
  });
}

if ("caches" in window) {
  caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
}

const BINGO_COLUMNS = [
  { letter: "B", from: 1, to: 15 },
  { letter: "I", from: 16, to: 30 },
  { letter: "N", from: 31, to: 45 },
  { letter: "G", from: 46, to: 60 },
  { letter: "O", from: 61, to: 75 },
];

const STATIC_PATTERNS = [
  { id: "column-b", label: "Columna B", cells: range(0, 4).map((row) => [row, 0]) },
  { id: "column-i", label: "Columna I", cells: range(0, 4).map((row) => [row, 1]) },
  { id: "column-n", label: "Columna N", cells: range(0, 4).map((row) => [row, 2]) },
  { id: "column-g", label: "Columna G", cells: range(0, 4).map((row) => [row, 3]) },
  { id: "column-o", label: "Columna O", cells: range(0, 4).map((row) => [row, 4]) },
  { id: "row-top", label: "Fila superior", cells: range(0, 4).map((col) => [0, col]) },
  { id: "row-middle", label: "Fila central", cells: range(0, 4).map((col) => [2, col]) },
  { id: "row-bottom", label: "Fila inferior", cells: range(0, 4).map((col) => [4, col]) },
  { id: "diag-left", label: "Diagonal izquierda a derecha", cells: range(0, 4).map((index) => [index, index]) },
  { id: "diag-right", label: "Diagonal derecha a izquierda", cells: range(0, 4).map((index) => [index, 4 - index]) },
  { id: "corners", label: "Cuatro esquinas", cells: [[0, 0], [0, 4], [4, 0], [4, 4]] },
  { id: "full-card", label: "Carton completo", cells: range(0, 4).flatMap((row) => range(0, 4).map((col) => [row, col])) },
];

const SPECIAL_PATTERNS = [
  { id: "any-row", label: "Cualquier fila" },
  { id: "any-column", label: "Cualquier columna" },
];

const DEFAULT_CUSTOM_CELLS = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [0, 4], [1, 3], [3, 1], [4, 0]];

const state = {
  roomCode: "BINGO-4821",
  round: 58,
  maxTickets: 5,
  prize: 240000,
  pattern: null,
  customPatternCells: [...DEFAULT_CUSTOM_CELLS],
  status: "preparing",
  currentPlayerId: null,
  nextTicketId: 15,
  players: [],
  tickets: [],
  drawn: [],
  audit: [],
  requests: [],
  selectedPlayerId: null,
  pendingWinner: null,
  confirmedWinner: null,
  timer: null,
  countdown: 5,
  autoMode: false,
};

function getBall(number) {
  const value = Number(number);
  const column = BINGO_COLUMNS.find((item) => value >= item.from && value <= item.to);
  return column ? { letter: column.letter, number: value, label: `${column.letter}-${value}` } : null;
}

function ballHtml(number, size = "normal") {
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

function serializeRoomState() {
  return {
    roomCode: state.roomCode,
    round: state.round,
    maxTickets: state.maxTickets,
    prize: state.prize,
    pattern: state.pattern,
    customPatternCells: state.customPatternCells,
    status: state.status,
    currentPlayerId: state.currentPlayerId,
    nextTicketId: state.nextTicketId,
    players: state.players,
    tickets: state.tickets.map((ticket) => ({
      ...ticket,
      manualMarks: Array.from(ticket.manualMarks),
    })),
    drawn: state.drawn,
    requests: state.requests,
    selectedPlayerId: state.selectedPlayerId,
    pendingWinner: state.pendingWinner,
    confirmedWinner: state.confirmedWinner,
    countdown: state.countdown,
    autoMode: state.autoMode,
  };
}

function hydrateRoomState(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.players) || !Array.isArray(snapshot.tickets)) return false;
  Object.assign(state, {
    roomCode: snapshot.roomCode || state.roomCode,
    round: Number(snapshot.round) || state.round,
    maxTickets: Number(snapshot.maxTickets) || state.maxTickets,
    prize: Number(snapshot.prize) || state.prize,
    pattern: snapshot.pattern || null,
    customPatternCells: snapshot.customPatternCells || [...DEFAULT_CUSTOM_CELLS],
    status: snapshot.status || "preparing",
    currentPlayerId: snapshot.currentPlayerId || null,
    nextTicketId: Number(snapshot.nextTicketId) || state.nextTicketId,
    players: snapshot.players,
    tickets: snapshot.tickets.map((ticket) => ({
      ...ticket,
      manualMarks: new Set(ticket.manualMarks || ["FREE"]),
    })),
    drawn: snapshot.drawn || [],
    requests: snapshot.requests || [],
    selectedPlayerId: snapshot.selectedPlayerId || null,
    pendingWinner: snapshot.pendingWinner || null,
    confirmedWinner: snapshot.confirmedWinner || null,
    countdown: Number(snapshot.countdown) || state.countdown,
    autoMode: Boolean(snapshot.autoMode),
  });
  return true;
}

function loadRoomState() {
  try {
    return hydrateRoomState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch (error) {
    return false;
  }
}

function persistRoomState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeRoomState()));
  } catch (error) {
    // Storage can be unavailable in private windows; the app still works locally.
  }
}

function publishRoomState() {
  if (!window.location.protocol.startsWith("http")) return;
  fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serializeRoomState()),
  }).catch(() => {});
}

function createBingoTicket(id, ownerId) {
  const columns = {};
  BINGO_COLUMNS.forEach(({ letter, from, to }) => {
    columns[letter] = shuffle(range(from, to)).slice(0, 5).sort((a, b) => a - b);
  });

  return {
    id,
    code: ticketCode(id),
    columns,
    status: "reserved",
    ownerId,
    manualMarks: new Set(["FREE"]),
    paidAmount: 0,
  };
}

function createPlayer(name, document, quantity, paid = false) {
  const player = {
    id: `p${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    name,
    document,
    tickets: [],
    paid,
    totalPaid: 0,
  };
  state.players.push(player);
  assignTickets(player, quantity, paid);
  state.currentPlayerId = player.id;
  return player;
}

function assignTickets(player, quantity, paid = false) {
  const allowed = Math.max(0, state.maxTickets - player.tickets.length);
  const count = Math.min(quantity, allowed);
  for (let index = 0; index < count; index += 1) {
    const ticket = createBingoTicket(state.nextTicketId, player.id);
    ticket.status = paid ? "paid" : "reserved";
    ticket.paidAmount = 0;
    state.tickets.push(ticket);
    player.tickets.push(ticket.id);
    state.nextTicketId += 1;
  }
  player.paid = player.tickets.every((id) => ["paid", "in-game", "winner"].includes(getTicket(id)?.status));
}

function seedDemo() {
  const jesus = createPlayer("Jesus Parra", "1001", 3, true);
  const laura = createPlayer("Laura Gomez", "1002", 1, true);
  const carlos = createPlayer("Carlos Ruiz", "4481", 5, true);
  state.currentPlayerId = jesus.id;
  state.selectedPlayerId = jesus.id;
}

function getTicket(id) {
  return state.tickets.find((ticket) => ticket.id === Number(id));
}

function getPlayer(id) {
  return state.players.find((player) => player.id === id);
}

function currentPlayer() {
  return getPlayer(state.currentPlayerId) || null;
}

function addAudit(message) {
  const time = new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  state.audit.unshift({ time, message });
  state.audit = state.audit.slice(0, 20);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1900);
}

function renderAll() {
  renderQr();
  renderStats();
  renderRules();
  renderPayments();
  renderCashier();
  renderRegistry();
  renderControlBoard();
  renderPlayer();
  renderTicketSummary();
  renderHistory();
  renderRequests();
  renderAudit();
  renderPublic();
  renderWinnerOverlay();
  renderFloatingBalls();
  persistRoomState();
  publishRoomState();
}

function renderQr() {
  const entryUrl = new URL("player.html", window.location.href);
  entryUrl.searchParams.set("room", state.roomCode);
  if (["127.0.0.1", "localhost"].includes(entryUrl.hostname) && LAN_FALLBACK_HOST) {
    entryUrl.hostname = LAN_FALLBACK_HOST;
  }
  const playerUrl = entryUrl.toString();
  $("#qrCode").src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(playerUrl)}`;
  $("#qrLinkText").textContent = "Escanear para jugador";
}

function renderStats() {
  const reserved = state.tickets.filter((ticket) => ticket.status === "reserved").length;
  const paid = state.tickets.filter((ticket) => ["paid", "in-game", "winner"].includes(ticket.status)).length;
  const playersWithTickets = state.players.filter((player) => player.tickets.length).length;

  $("#statPlayers").textContent = playersWithTickets;
  $("#statAvailable").textContent = state.tickets.length;
  $("#statReserved").textContent = reserved;
  $("#statPaid").textContent = paid;
  $("#cashierReserved").textContent = reserved;
  $("#cashierPaid").textContent = paid;
  $("#salesTotal").textContent = pesos(state.tickets.reduce((sum, ticket) => sum + ticket.paidAmount, 0));
  $("#publicPlayers").textContent = playersWithTickets;
  $("#maxTicketsLabel").textContent = state.maxTickets;
  $("#prizeLabel").textContent = pesos(state.prize);
  $("#publicPrize").textContent = pesos(state.prize);
  const prizeInput = $("#prizeInput");
  if (document.activeElement !== prizeInput) prizeInput.value = state.prize;
  const patternLabel = state.pattern?.label || "Sin seleccionar";
  $("#patternLabel").textContent = patternLabel;
  $("#selectedRuleTitle").textContent = `Regla seleccionada: ${patternLabel}`;
  $("#activeRuleText").textContent = state.pattern
    ? `La partida validara automaticamente: ${patternLabel}.`
    : "Selecciona una regla antes de iniciar la partida.";
  $("#activeRulePreview").innerHTML = renderPatternMini(state.pattern ? patternCellsForPreview(state.pattern) : []);
  $("#roundState").textContent = state.status === "live" ? "En juego" : state.status === "paused" ? "Pausada" : "Preparando";
  $("#roundState").className = `status-chip ${state.status === "live" ? "live" : "pending"}`;
}

function renderRules() {
  const rulesGrid = $("#rulesGrid");
  const customGrid = $("#customPatternGrid");
  if (!rulesGrid || !customGrid) return;

  const allRules = [...STATIC_PATTERNS, ...SPECIAL_PATTERNS];
  rulesGrid.innerHTML = allRules.map((pattern) => `
    <button class="rule-card ${state.pattern?.id === pattern.id ? "selected" : ""}" data-select-rule="${pattern.id}">
      <strong>${pattern.label}</strong>
      <span class="rule-mini">${renderPatternMini(patternCellsForPreview(pattern))}</span>
    </button>
  `).join("");

  customGrid.innerHTML = range(0, 4).map((row) =>
    range(0, 4).map((col) => {
      const active = state.customPatternCells.some(([r, c]) => r === row && c === col);
      return `<button class="custom-cell ${active ? "active" : ""}" data-custom-cell="${row}:${col}"></button>`;
    }).join(""),
  ).join("");
}

function renderPatternMini(cells) {
  const active = new Set(cells.map(([row, col]) => `${row}:${col}`));
  return range(0, 4).map((row) =>
    range(0, 4).map((col) => `<i class="${active.has(`${row}:${col}`) ? "active" : ""}"></i>`).join(""),
  ).join("");
}

function patternCellsForPreview(pattern) {
  if (!pattern) return [];
  if (pattern.id === "any-row") return range(0, 4).map((col) => [2, col]);
  if (pattern.id === "any-column") return range(0, 4).map((row) => [row, 1]);
  if (pattern.id === "custom") return state.customPatternCells;
  return pattern.cells || [];
}

function selectPattern(patternId) {
  if (state.status === "live" || state.pendingWinner) {
    showToast("No puedes cambiar la regla durante la partida");
    return;
  }
  if (patternId === "custom") {
    if (!state.customPatternCells.length) {
      showToast("Selecciona al menos una casilla para el patron personalizado");
      return;
    }
    state.pattern = { id: "custom", label: "Patron personalizado", cells: [...state.customPatternCells] };
  } else {
    const pattern = [...STATIC_PATTERNS, ...SPECIAL_PATTERNS].find((item) => item.id === patternId);
    if (!pattern) return;
    state.pattern = { ...pattern };
  }
  addAudit(`Operador selecciono regla: ${state.pattern.label}`);
  $("#rulesModal").classList.remove("show");
  renderAll();
}

function paymentItems() {
  return state.players
    .filter((player) => player.tickets.some((ticketId) => getTicket(ticketId)?.status === "reserved"))
    .map((player) => {
      const ids = player.tickets.filter((ticketId) => getTicket(ticketId)?.status === "reserved");
      return { player, ids };
    });
}

function renderPayments() {
  const items = paymentItems();
  const empty = `<div class="payment-item"><div><strong>Sin cartones pendientes</strong><span class="muted">Los registros nuevos apareceran aqui.</span></div></div>`;
  $("#pendingPayments").innerHTML = items.map(renderPaymentItem).join("") || empty;
}

function renderCashier() {
  const search = $("#cashierSearch").value.trim().toLowerCase();
  const items = paymentItems().filter(({ player }) => {
    if (!search) return true;
    return `${player.name} ${player.document}`.toLowerCase().includes(search);
  });
  const empty = `<div class="payment-item"><div><strong>No hay cartones pendientes</strong><span class="muted">Registra un jugador desde la vista Jugador.</span></div></div>`;
  $("#cashierList").innerHTML = items.map(renderPaymentItem).join("") || empty;
}

function renderPaymentItem({ player, ids }) {
  return `
    <article class="payment-item">
      <div>
        <strong>${player.name}</strong>
        <span class="muted">ID ${player.document || "sin registro"} - Cartones asignados: ${ids.map(ticketShort).join(" y ")}</span>
      </div>
      <div class="payment-actions">
        <button data-pay="${player.id}">Activar cartones</button>
        <button data-cancel="${player.id}">Anular</button>
      </div>
    </article>
  `;
}

function renderRegistry() {
  const empty = `<div class="request-item"><strong>Sin jugadores</strong><span class="muted">Registra compradores para generar cartones automaticos.</span></div>`;
  $("#playerRegistry").innerHTML = state.players.map((player) => {
    const nextLabel = player.tickets.some((id) => {
      const result = evaluateTicket(getTicket(id));
      return result.near;
    }) ? `<span class="near-chip">Proximo a bingo</span>` : "";
    return `
      <article class="request-item registry-item ${state.selectedPlayerId === player.id ? "selected" : ""}" data-player-detail="${player.id}">
        <strong>${player.name} - ${player.tickets.length} ${player.tickets.length === 1 ? "carton" : "cartones"}</strong>
        <span class="muted">Documento: ${player.document || "N/A"}</span>
        <span class="muted">Cartones asignados: ${player.tickets.map(ticketShort).join(" y ") || "ninguno"}</span>
        <span class="muted">Partida ${state.round}</span>
        ${nextLabel}
      </article>
    `;
  }).join("") || empty;
  renderPlayerInspector();
}

function renderPlayerInspector() {
  const panel = $("#playerInspector");
  const player = getPlayer(state.selectedPlayerId);
  if (!player) {
    panel.innerHTML = `<div class="inspector-empty">Haz clic sobre un jugador para revisar sus cartones.</div>`;
    return;
  }

  const tickets = player.tickets.map(getTicket).filter(Boolean);
  panel.innerHTML = `
    <div class="inspector-head">
      <strong>${player.name}</strong>
      <span>${tickets.length} ${tickets.length === 1 ? "carton asignado" : "cartones asignados"}</span>
    </div>
    <div class="inspector-meta">
      <span>Documento: ${player.document || "N/A"}</span>
      <span>Regla: ${state.pattern?.label || "Sin seleccionar"}</span>
      <span>Marcadas: ${state.drawn.map((number) => getBall(number).label).join(", ") || "ninguna"}</span>
    </div>
    <div class="inspector-tickets">
      ${tickets.map((ticket) => {
        const result = evaluateTicket(ticket);
        return `
          <article class="inspector-ticket">
            <div class="inspector-ticket-title">
              <strong>Carton ${ticketShort(ticket.id)}</strong>
              <span>${statusLabel(ticket.status)}</span>
            </div>
            <span class="muted">ID: ${ticket.code}</span>
            <span class="muted">${result.valid ? "Bingo completo" : result.near ? "Proximo a completar regla" : "En juego"}</span>
            ${renderTicketCard(ticket, result.cells)}
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderControlBoard() {
  const list = $("#controlPlayerList");
  const inspector = $("#controlInspector");
  if (!list || !inspector) return;

  list.innerHTML = state.players.map((player) => {
    const near = player.tickets.some((id) => evaluateTicket(getTicket(id)).near);
    return `
      <button class="control-player ${state.selectedPlayerId === player.id ? "selected" : ""}" data-player-detail="${player.id}">
        <strong>${player.name}</strong>
        <span>${player.tickets.length} ${player.tickets.length === 1 ? "carton" : "cartones"}</span>
        ${near ? `<small>Proximo a completar regla</small>` : `<small>Click para revisar</small>`}
      </button>
    `;
  }).join("");

  const player = getPlayer(state.selectedPlayerId) || state.players[0];
  if (!player) {
    inspector.innerHTML = `<div class="inspector-empty">No hay jugadores registrados.</div>`;
    return;
  }

  const tickets = player.tickets.map(getTicket).filter(Boolean);
  inspector.innerHTML = `
    <div class="control-detail-header">
      <div>
        <strong>${player.name}</strong>
        <span>Documento: ${player.document || "N/A"}</span>
      </div>
      <div>
        <strong>${tickets.length}</strong>
        <span>${tickets.length === 1 ? "carton asignado" : "cartones asignados"}</span>
      </div>
      <div>
        <button class="danger-button delete-player" data-delete-player="${player.id}">Quitar jugador</button>
        <span>Nueva ronda o retiro</span>
      </div>
    </div>
    <div class="control-detail-meta">
      <span>Regla jugando: ${state.pattern?.label || "Sin seleccionar"}</span>
      <span>Numeros marcados: ${state.drawn.map((number) => getBall(number).label).join(", ") || "ninguno"}</span>
      <span>IDs de cartones: ${tickets.map((ticket) => ticketShort(ticket.id)).join(", ")}</span>
    </div>
    <div class="control-ticket-strip">
      ${tickets.map((ticket) => {
        const result = evaluateTicket(ticket);
        return `
          <article class="control-ticket-card">
            <div class="control-ticket-meta">
              <strong>Carton ${ticketShort(ticket.id)}</strong>
              <span>${statusLabel(ticket.status)}</span>
              <span>${result.valid ? "Bingo valido" : result.near ? "Proximo a completar" : `Faltan ${result.missing}`}</span>
            </div>
            ${renderTicketCard(ticket, result.valid || result.near ? result.cells : [])}
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderTicketSummary() {
  const player = currentPlayer();
  if (!player) {
    $("#ticketPicker").innerHTML = `<div class="ticket-pick empty">Ingresa los datos del jugador para generar cartones automaticos.</div>`;
    return;
  }
  $("#ticketPicker").innerHTML = player.tickets.map((id) => {
    const ticket = getTicket(id);
    return `
      <article class="ticket-pick ${ticket.status}">
        <strong>Carton ${ticketShort(ticket.id)}</strong>
        <span>${ticket.code}</span>
        <small>${player.name}</small>
      </article>
    `;
  }).join("");
}

function renderPlayer() {
  const player = currentPlayer();
  const tickets = player ? player.tickets.map(getTicket).filter(Boolean) : [];
  const activeCount = tickets.filter((ticket) => ["paid", "in-game", "winner"].includes(ticket.status)).length;

  $("#playerTotal").textContent = String(tickets.length);
  $("#paymentState").textContent = activeCount ? "Activo" : "Sin cartones";
  $("#paymentState").className = `status-chip ${activeCount ? "ok" : "pending"}`;
  $("#playerStatus").textContent = tickets.length
    ? `Jugador: ${player.name}. Cartones asignados: ${player.tickets.map(ticketShort).join(" y ")}.`
    : "Ingresa los datos para generar cartones automaticos.";

  $("#playerTickets").innerHTML = tickets.length
    ? tickets.map((ticket) => renderTicketCard(ticket)).join("")
    : `<div class="join-card"><strong>Sin cartones</strong><p class="muted">Completa nombre, identificacion y cantidad; luego presiona Generar.</p></div>`;
}

function ticketNumbers(ticket) {
  return BINGO_COLUMNS.flatMap(({ letter }) => ticket.columns[letter].map((number) => ({ letter, number })));
}

function renderTicketCard(ticket, highlightCells = []) {
  const owner = getPlayer(ticket.ownerId);
  const highlightSet = new Set(highlightCells.map(([row, col]) => `${row}:${col}`));
  const rows = range(0, 4).map((row) => {
    const cells = BINGO_COLUMNS.map(({ letter }, col) => {
      const winning = highlightSet.has(`${row}:${col}`);
      if (letter === "N" && row === 2) {
        return `<button class="cell free drawn ${winning ? "winning" : ""}" data-free="true">LIBRE</button>`;
      }
      const number = ticket.columns[letter][row];
      const drawn = state.drawn.includes(number);
      const manual = ticket.manualMarks.has(number);
      return `<button class="cell ${drawn ? "drawn" : ""} ${manual ? "manual" : ""} ${winning ? "winning" : ""}" data-mark="${ticket.id}:${number}">${number}</button>`;
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

function renderHistory() {
  const balls = state.drawn.slice(-24).map((number) => `<span class="history-ball">${ballHtml(number)}</span>`).join("");
  $("#historyTrack").innerHTML = balls;
  $("#mobileHistory").innerHTML = balls;
  $("#currentBall").innerHTML = state.drawn.length ? ballHtml(state.drawn.at(-1)) : "--";
  $("#publicBall").innerHTML = state.drawn.length ? ballHtml(state.drawn.at(-1)) : "--";
}

function renderRequests() {
  const container = $("#bingoRequests");
  const winner = state.requests.find((request) => request.status === "Aprobado");
  const winnerNode = $("#winnerName");
  if (winnerNode) winnerNode.textContent = state.confirmedWinner?.playerName || state.pendingWinner?.playerName || winner?.player || "Pendiente";
  if (!container) return;
  const empty = `<div class="request-item"><strong>Sin solicitudes</strong><span class="muted">El servidor valida el carton contra las balotas B-I-N-G-O sorteadas.</span></div>`;
  container.innerHTML = state.requests.map((request) => `
    <article class="request-item">
      <strong>${request.player}</strong>
      <span class="muted">${request.ticket} - ${request.status}</span>
    </article>
  `).join("") || empty;
}

function renderAudit() {
  const container = $("#auditLog");
  if (!container) return;
  container.innerHTML = state.audit
    .map((item) => `<article class="audit-item"><strong>${item.time}</strong><br><span class="muted">${item.message}</span></article>`)
    .join("");
}

function renderPublic() {
  $("#publicHistory").innerHTML = state.drawn.slice(-16).map((number) => `<span class="history-ball">${ballHtml(number)}</span>`).join("");
  $("#publicCountdown").textContent = String(state.countdown).padStart(2, "0");
  $("#publicPattern").textContent = state.pattern?.label || "Sin seleccionar";
  const playerPattern = $("#playerPattern");
  if (playerPattern) playerPattern.textContent = state.pattern?.label || "Sin seleccionar";
}

function renderWinnerOverlay() {
  const overlay = $("#winnerOverlay");
  const winner = state.pendingWinner || state.confirmedWinner;
  if (!winner) {
    overlay.classList.remove("show");
    $("#rectifyPanel").innerHTML = "";
    return;
  }

  overlay.classList.add("show");
  $("#winnerSummary").innerHTML = `
    <p><strong>Ganador:</strong> ${winner.playerName}</p>
    <p><strong>Carton ganador:</strong> ${ticketShort(winner.ticketId)}</p>
    <p><strong>Regla completada:</strong> ${winner.ruleLabel}</p>
    <p><strong>Ultima balota:</strong> ${winner.lastBall.label}</p>
    <p><strong>Premio:</strong> ${pesos(state.prize)}</p>
  `;
  $("#rectifyPanel").classList.toggle("show", Boolean(winner.showRectify));
  if (winner.showRectify) {
    const ticket = getTicket(winner.ticketId);
    $("#rectifyPanel").innerHTML = `
      <div class="rectify-grid">
        <div>
          <h3>Rectificacion</h3>
          <p><strong>Jugador:</strong> ${winner.playerName}</p>
          <p><strong>Carton:</strong> ${ticketShort(winner.ticketId)}</p>
          <p><strong>Regla seleccionada:</strong> ${state.pattern?.label || "Sin seleccionar"}</p>
          <p><strong>Resultado:</strong> Bingo valido</p>
          <p><strong>Balotas sorteadas:</strong> ${state.drawn.map((number) => getBall(number).label).join(", ")}</p>
        </div>
        <div>${renderTicketCard(ticket, winner.cells)}</div>
      </div>
    `;
  }
}

function renderFloatingBalls() {
  const drum = $("#floatingBalls");
  drum.innerHTML = shuffle(range(1, 75)).slice(0, 22).map((number, index) => {
    const left = 8 + Math.random() * 72;
    const top = 8 + Math.random() * 70;
    const size = 21 + (index % 3) * 3;
    return `<span class="mini-ball" style="left:${left}%;top:${top}%;width:${size}px;height:${size}px;animation-delay:${index * 0.08}s">${ballHtml(number)}</span>`;
  }).join("");
}

function registerPlayerFromForm() {
  const name = $("#playerName").value.trim();
  const document = $("#playerDocument").value.trim();
  const requested = Number($("#ticketQuantity").value);
  const quantity = Math.min(Math.max(requested || 1, 1), state.maxTickets);

  if (!name) {
    showToast("Ingresa el nombre del jugador");
    return;
  }

  let player = state.players.find((item) => item.document && item.document === document);
  if (!player) {
    player = createPlayer(name, document, quantity, true);
    addAudit(`${player.name} registro ${quantity} carton(es): ${player.tickets.map(ticketShort).join(" y ")}`);
  } else {
    state.currentPlayerId = player.id;
    player.name = name;
    const needed = quantity - player.tickets.length;
    if (needed > 0) assignTickets(player, needed, true);
    addAudit(`${player.name} actualizo su registro`);
  }

  state.selectedPlayerId = player.id;
  state.currentPlayerId = player.id;
  showToast(`Cartones generados para ${player.name}: ${player.tickets.map(ticketShort).join(" y ")}`);
  $("#playerName").value = "";
  $("#playerDocument").value = "";
  $("#ticketQuantity").value = 1;
  renderAll();
}

function deletePlayer(playerId) {
  const player = getPlayer(playerId);
  if (!player) return;
  state.tickets = state.tickets.filter((ticket) => ticket.ownerId !== playerId);
  state.players = state.players.filter((item) => item.id !== playerId);
  if (state.currentPlayerId === playerId) state.currentPlayerId = state.players[0]?.id || null;
  if (state.selectedPlayerId === playerId) state.selectedPlayerId = state.players[0]?.id || null;
  addAudit(`Operador quito a ${player.name} de la ronda`);
  showToast(`${player.name} eliminado de la ronda`);
  renderAll();
}

function clearPlayersForNewRound() {
  state.players = [];
  state.tickets = [];
  state.currentPlayerId = null;
  state.selectedPlayerId = null;
  state.drawn = [];
  state.pendingWinner = null;
  state.confirmedWinner = null;
  state.status = "preparing";
  state.autoMode = false;
  state.nextTicketId = 15;
  window.clearInterval(state.timer);
  addAudit("Operador limpio jugadores para nueva ronda");
  showToast("Jugadores eliminados para nueva ronda");
  renderAll();
}

function activateView(viewName) {
  $$(".role-tab, .menu-nav").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewName));
  $$(".view").forEach((view) => view.classList.remove("active"));
  $(`#${viewName}View`).classList.add("active");
  $("#sideMenu").classList.remove("show");
  $("#menuBackdrop").classList.remove("show");
  window.scrollTo(0, 0);
}

function toggleMenu(show) {
  $("#sideMenu").classList.toggle("show", show);
  $("#menuBackdrop").classList.toggle("show", show);
}

function confirmPayment(playerId) {
  const player = getPlayer(playerId);
  if (!player) return;

  player.tickets.forEach((ticketId) => {
    const ticket = getTicket(ticketId);
    if (ticket?.status === "reserved") {
      ticket.status = "paid";
      ticket.paidAmount = 0;
    }
  });
  player.totalPaid = player.tickets.reduce((sum, id) => sum + (getTicket(id)?.paidAmount || 0), 0);
  player.paid = true;
  addAudit(`Operador activo cartones de ${player.name} para la partida ${state.round}`);
  showToast(`Cartones activos: ${player.name}`);
  renderAll();
}

function cancelReservation(playerId) {
  const player = getPlayer(playerId);
  if (!player) return;

  player.tickets.forEach((ticketId) => {
    const ticket = getTicket(ticketId);
    if (ticket?.status === "reserved") {
      state.tickets = state.tickets.filter((item) => item.id !== ticket.id);
    }
  });
  player.tickets = player.tickets.filter((ticketId) => getTicket(ticketId)?.ownerId === player.id);
  addAudit(`Operador anulo registro de ${player.name}`);
  showToast(`Registro anulado: ${player.name}`);
  renderAll();
}

function startRound() {
  if (!state.pattern) {
    showToast("Selecciona una regla antes de iniciar la partida");
    $("#rulesModal").classList.add("show");
    return;
  }

  if (!state.tickets.some((ticket) => ticket.status === "paid")) {
    showToast("Registra al menos un jugador antes de iniciar");
    return;
  }

  state.status = "live";
  state.tickets.forEach((ticket) => {
    if (ticket.status === "paid") ticket.status = "in-game";
  });
  addAudit("Operador inicio la ronda B-I-N-G-O");
  showToast("Ronda iniciada");
  startCountdown();
  renderAll();
}

function pauseRound() {
  state.status = "paused";
  state.autoMode = false;
  window.clearInterval(state.timer);
  addAudit("Operador pauso la ronda");
  showToast("Ronda pausada");
  renderAll();
}

function finishRound() {
  state.status = "finished";
  state.autoMode = false;
  window.clearInterval(state.timer);
  addAudit("Operador finalizo la ronda");
  showToast("Ronda finalizada");
  renderAll();
}

function publishNumber(number) {
  if (state.pendingWinner) {
    showToast("Hay un bingo en rectificacion. No se pueden sacar mas balotas.");
    return;
  }

  if (state.status !== "live") {
    showToast("Primero inicia la ronda");
    return;
  }

  const value = Number(number);
  const ball = getBall(value);
  if (!ball) {
    showToast("Ingresa un numero entre 1 y 75");
    return;
  }

  if (state.drawn.includes(value)) {
    showToast(`${ball.label} ya fue anunciado`);
    return;
  }

  state.drawn.push(value);
  addAudit(`Operador publico balota ${ball.label}`);
  pulseBalls();
  detectAlmost();
  checkAutomaticWinner(ball);
  renderAll();
}

function autoDraw() {
  if (state.status !== "live") startRound();
  if (state.status !== "live") return;
  const remaining = range(1, 75).filter((number) => !state.drawn.includes(number));
  if (!remaining.length) {
    finishRound();
    return;
  }
  publishNumber(remaining[Math.floor(Math.random() * remaining.length)]);
}

function startCountdown() {
  state.countdown = 5;
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    state.countdown = state.countdown <= 0 ? 5 : state.countdown - 1;
    renderPublic();
    if (state.autoMode && state.countdown === 0) autoDraw();
  }, 1000);
}

function pulseBalls() {
  ["#currentBall", "#publicBall"].forEach((selector) => {
    const ball = $(selector);
    ball.classList.remove("hit");
    void ball.offsetWidth;
    ball.classList.add("hit");
  });
}

function ticketMatchedCount(ticket) {
  return ticketNumbers(ticket).filter(({ number, letter }) => (letter === "N" && number === ticket.columns.N[2]) || state.drawn.includes(number)).length;
}

function ticketIsWinner(ticket) {
  return evaluateTicket(ticket).valid;
}

function cellIsMarked(ticket, row, col) {
  const letter = BINGO_COLUMNS[col].letter;
  const number = ticket.columns[letter][row];
  return (letter === "N" && row === 2) || state.drawn.includes(number);
}

function evaluateTicket(ticket) {
  if (!ticket || !state.pattern) return { valid: false, near: false, cells: [], missing: 25, ruleLabel: "Sin regla" };
  const candidates = getPatternCandidates(state.pattern);
  const checked = candidates.map((candidate) => {
    const missing = candidate.cells.filter(([row, col]) => !cellIsMarked(ticket, row, col)).length;
    return { ...candidate, missing };
  });
  const winner = checked.find((candidate) => candidate.missing === 0);
  const nearest = checked.reduce((best, candidate) => (candidate.missing < best.missing ? candidate : best), checked[0]);
  return {
    valid: Boolean(winner),
    near: !winner && nearest.missing === 1,
    cells: winner ? winner.cells : nearest.cells,
    missing: winner ? 0 : nearest.missing,
    ruleLabel: winner ? winner.label : `${state.pattern.label}: faltan ${nearest.missing}`,
  };
}

function getPatternCandidates(pattern) {
  if (pattern.id === "any-row") {
    return range(0, 4).map((row) => ({ label: rowLabel(row), cells: range(0, 4).map((col) => [row, col]) }));
  }
  if (pattern.id === "any-column") {
    return range(0, 4).map((col) => ({ label: `Columna ${BINGO_COLUMNS[col].letter}`, cells: range(0, 4).map((row) => [row, col]) }));
  }
  return [{ label: pattern.label, cells: pattern.cells || [] }];
}

function rowLabel(row) {
  return ["Fila superior", "Segunda fila", "Fila central", "Cuarta fila", "Fila inferior"][row] || "Fila";
}

function checkAutomaticWinner(lastBall) {
  const activeTickets = state.tickets.filter((ticket) => ["paid", "in-game"].includes(ticket.status));
  for (const ticket of activeTickets) {
    const result = evaluateTicket(ticket);
    if (!result.valid) continue;
    const player = getPlayer(ticket.ownerId);
    state.pendingWinner = {
      playerId: player.id,
      playerName: player.name,
      ticketId: ticket.id,
      ruleLabel: result.ruleLabel,
      cells: result.cells,
      lastBall,
      showRectify: false,
    };
    state.status = "paused";
    state.autoMode = false;
    window.clearInterval(state.timer);
    state.requests.unshift({ player: player.name, ticket: ticket.code, status: `Automatico: ${result.ruleLabel}` });
    addAudit(`Sistema detecto BINGO automatico de ${player.name} en carton ${ticketShort(ticket.id)} por ${result.ruleLabel}`);
    playWinnerSound();
    return;
  }
}

function forceDemoAutoBingo() {
  const targetPlayer = getPlayer(state.selectedPlayerId) || state.players[0];
  if (!targetPlayer) return;
  const ticket = targetPlayer.tickets.map(getTicket).find(Boolean);
  if (!ticket) return;
  if (!state.pattern) {
    state.pattern = { ...STATIC_PATTERNS.find((pattern) => pattern.id === "row-top") };
  }

  state.pendingWinner = null;
  state.confirmedWinner = null;
  state.status = "live";
  state.autoMode = false;
  window.clearInterval(state.timer);
  ticket.status = ticket.status === "reserved" ? "paid" : ticket.status;
  ticket.paidAmount = 0;

  const topRowNumbers = BINGO_COLUMNS.map(({ letter }) => ticket.columns[letter][0]);
  state.drawn = [];
  topRowNumbers.forEach((number, index) => {
    state.drawn.push(number);
    addAudit(`Demo publico balota ${getBall(number).label}`);
    if (index === topRowNumbers.length - 1) {
      checkAutomaticWinner(getBall(number));
    }
  });
  if (state.pendingWinner) {
    showToast(`BINGO automatico detectado: ${state.pendingWinner.playerName}`);
  }
  renderAll();
}

function detectAlmost() {
  state.players.forEach((player) => {
    player.tickets.map(getTicket).filter(Boolean).forEach((ticket) => {
      const result = evaluateTicket(ticket);
      if (result.near) {
        showToast(`${player.name} esta a una balota de BINGO`);
      }
    });
  });
}

function claimBingo() {
  const player = currentPlayer();
  if (!player) {
    showToast("Primero genera tus cartones");
    return;
  }

  const eligible = player.tickets
    .map(getTicket)
    .filter((ticket) => ticket && ["paid", "in-game", "winner"].includes(ticket.status));

  if (!eligible.length) {
    showToast("Tu carton aun no esta activo");
    return;
  }

  const winningTicket = eligible.find(ticketIsWinner);
  if (winningTicket) {
    const result = evaluateTicket(winningTicket);
    state.pendingWinner = {
      playerId: player.id,
      playerName: player.name,
      ticketId: winningTicket.id,
      ruleLabel: result.ruleLabel,
      cells: result.cells,
      lastBall: getBall(state.drawn.at(-1)),
      showRectify: false,
    };
    state.status = "paused";
    state.autoMode = false;
    window.clearInterval(state.timer);
    state.requests.unshift({ player: player.name, ticket: winningTicket.code, status: `Avisado y valido: ${result.ruleLabel}` });
    addAudit(`Servidor valido aviso de BINGO de ${player.name} en carton ${ticketShort(winningTicket.id)}`);
    playWinnerSound();
  } else {
    const nearest = eligible.map((ticket) => ({ ticket, result: evaluateTicket(ticket) })).sort((a, b) => a.result.missing - b.result.missing)[0];
    state.requests.unshift({ player: player.name, ticket: eligible[0].code, status: `Bingo no valido: faltan ${nearest.result.missing} casilla(s)` });
    addAudit(`Servidor rechazo BINGO de ${player.name}`);
    showToast(`Bingo no valido: faltan ${nearest.result.missing} casilla(s) para completar ${state.pattern?.label || "la regla seleccionada"}`);
  }
  renderAll();
}

function playWinnerSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    [392, 523, 659, 784].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = "triangle";
      oscillator.connect(gain);
      gain.connect(context.destination);
      gain.gain.setValueAtTime(0.0001, context.currentTime + index * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + index * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + index * 0.12 + 0.18);
      oscillator.start(context.currentTime + index * 0.12);
      oscillator.stop(context.currentTime + index * 0.12 + 0.2);
    });
  } catch (error) {
    // Audio can be blocked by the browser until user interaction; visual alert still works.
  }
}

function bindEvents() {
  $$(".role-tab").forEach((button) => {
    button.addEventListener("click", () => activateView(button.dataset.view));
  });
  $$(".menu-nav").forEach((button) => {
    button.addEventListener("click", () => activateView(button.dataset.view));
  });

  $("#menuButton").addEventListener("click", () => toggleMenu(true));
  $("#closeMenu").addEventListener("click", () => toggleMenu(false));
  $("#menuBackdrop").addEventListener("click", () => toggleMenu(false));
  $("#clearPlayersMenu").addEventListener("click", clearPlayersForNewRound);
  $("#clearPlayers").addEventListener("click", clearPlayersForNewRound);
  $("#togglePlayersPanel").addEventListener("click", () => {
    const panel = $("#playersPanelBody");
    const collapsed = panel.classList.toggle("collapsed");
    $("#togglePlayersPanel").textContent = collapsed ? "Mostrar jugadores" : "Ocultar jugadores";
  });
  $("#prizeInput").addEventListener("input", () => {
    state.prize = Math.max(0, Number($("#prizeInput").value) || 0);
    renderStats();
  });

  $("#joinRoom").addEventListener("click", registerPlayerFromForm);

  $("#openRules").addEventListener("click", () => $("#rulesModal").classList.add("show"));
  $("#closeRules").addEventListener("click", () => $("#rulesModal").classList.remove("show"));
  $("#rulesGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-select-rule]");
    if (button) selectPattern(button.dataset.selectRule);
  });
  $("#customPatternGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-custom-cell]");
    if (!button) return;
    const [row, col] = button.dataset.customCell.split(":").map(Number);
    const exists = state.customPatternCells.some(([r, c]) => r === row && c === col);
    state.customPatternCells = exists
      ? state.customPatternCells.filter(([r, c]) => r !== row || c !== col)
      : [...state.customPatternCells, [row, col]];
    renderRules();
  });
  $("#selectCustomRule").addEventListener("click", () => selectPattern("custom"));

  document.body.addEventListener("click", (event) => {
    const payButton = event.target.closest("[data-pay]");
    const cancelButton = event.target.closest("[data-cancel]");
    const markButton = event.target.closest("[data-mark]");
    const playerDetail = event.target.closest("[data-player-detail]");
    const deletePlayerButton = event.target.closest("[data-delete-player]");
    if (payButton) confirmPayment(payButton.dataset.pay);
    if (cancelButton) cancelReservation(cancelButton.dataset.cancel);
    if (deletePlayerButton) {
      deletePlayer(deletePlayerButton.dataset.deletePlayer);
      return;
    }
    if (playerDetail) {
      state.selectedPlayerId = playerDetail.dataset.playerDetail;
      state.currentPlayerId = state.selectedPlayerId;
      renderAll();
    }
    if (markButton) {
      const [ticketId, number] = markButton.dataset.mark.split(":").map(Number);
      const ticket = getTicket(ticketId);
      if (!ticket) return;
      if (!state.drawn.includes(number)) {
        showToast("Solo puedes marcar numeros que ya salieron en la partida");
        return;
      }
      if (ticket.manualMarks.has(number)) ticket.manualMarks.delete(number);
      else ticket.manualMarks.add(number);
      renderPlayer();
    }
  });

  $("#cashierSearch").addEventListener("input", renderCashier);
  $("#startRound").addEventListener("click", startRound);
  $("#pauseRound").addEventListener("click", pauseRound);
  $("#pauseRoundMain").addEventListener("click", pauseRound);
  $("#publicPause").addEventListener("click", pauseRound);
  $("#finishRound").addEventListener("click", finishRound);
  $("#publicFinish").addEventListener("click", finishRound);
  $("#claimBingo").addEventListener("click", claimBingo);
  $("#demoAutoBingo").addEventListener("click", forceDemoAutoBingo);
  $("#rectifyBingo").addEventListener("click", () => {
    if (!state.pendingWinner) return;
    state.pendingWinner.showRectify = true;
    addAudit(`Operador abrio rectificacion del carton ${ticketShort(state.pendingWinner.ticketId)}`);
    renderWinnerOverlay();
  });
  $("#confirmWinner").addEventListener("click", () => {
    if (!state.pendingWinner) return;
    const ticket = getTicket(state.pendingWinner.ticketId);
    ticket.status = "winner";
    state.confirmedWinner = { ...state.pendingWinner, showRectify: true };
    state.pendingWinner = null;
    addAudit(`Operador confirmo ganador ${state.confirmedWinner.playerName}`);
    showToast("Ganador confirmado");
    renderAll();
  });
  $("#continueRound").addEventListener("click", () => {
    if (!state.pendingWinner && !state.confirmedWinner) return;
    state.pendingWinner = null;
    state.confirmedWinner = null;
    state.status = "live";
    addAudit("Operador continuo la partida despues de rectificar");
    startCountdown();
    renderAll();
  });
  $("#finishWinnerRound").addEventListener("click", () => {
    if (state.pendingWinner) {
      const ticket = getTicket(state.pendingWinner.ticketId);
      ticket.status = "winner";
      state.confirmedWinner = { ...state.pendingWinner, showRectify: true };
      state.pendingWinner = null;
    }
    finishRound();
  });
  $("#drawBall").addEventListener("click", autoDraw);
  $("#autoNumber").addEventListener("click", () => {
    state.autoMode = !state.autoMode;
    if (state.autoMode) {
      showToast("Auto demo activado");
      autoDraw();
    } else {
      showToast("Auto demo detenido");
    }
  });
  $("#assignManual").addEventListener("click", () => {
    const player = createPlayer("Invitado Operador", `OP-${Date.now().toString().slice(-4)}`, 1, true);
    addAudit(`Operador asigno carton a ${player.name}: ${player.tickets.map(ticketShort).join(" y ")}`);
    showToast("Carton asignado");
    renderAll();
  });

  const initialView = new URLSearchParams(window.location.search).get("view");
  if (["operator", "player", "public"].includes(initialView)) activateView(initialView);
}

if (!loadRoomState()) {
  seedDemo();
  addAudit("Sala creada con QR para jugadores BINGO-4821");
}
bindEvents();
renderAll();
