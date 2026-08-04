/* ============================================================
   ROUNDS TAB -- Court setup, scheduling algorithm, rest queue, global state
   File: rounds.js
   ============================================================ */


var allRounds = [];
var lastRound = [];
var currentRoundIndex = 0;
var isOnPage2 = false;
var resetRest = false;


	
var schedulerState = {
    numCourts: 0,
    allPlayers: [],
    activeplayers: [],
    fixedPairs: [],
    PlayedCount:    new Map(),
    typePlayCount:  { MD: new Map(), LD: new Map(), XD: new Map() }, // per-type play counts
    restCount: new Map(),
    restQueue: new Map(),
    PlayerScoreMap: new Map(),
    playedTogether: new Map(),
    fixedMap: new Map(),
    roundIndex: 0,
    pairPlayedSet: new Set(),
    gamesMap: new Set(),
    markingWinnerMode: false,
    winCount: new Map(),
    pairCooldownMap: new Map(),
    rankPoints: new Map(),
    streakMap:  new Map(),
    courts:     1,
    courtTypes:   [],  // per-court type: 'free'|'MD'|'LD'|'XD'|'singles-free'|'singles-men'|'singles-women'
    courtFormats: [],  // per-court format: 'doubles'|'singles'
    uniqueGamesMode: true, // when true: unique game priority over rest queue
};

schedulerState.activeplayers = new Proxy([], {
  get(target, prop) {
    const value = target[prop];

    if (typeof value === 'function') {
      return function (...args) {
        const result = value.apply(target, args);
        updateRoundsPageAccess();
        return result;
      };
    }

    return value;
  }
});



allRounds = new Proxy(allRounds, {
  set(target, prop, value) {
    target[prop] = value;
    updateSummaryPageAccess();
  // Refresh round history in gear panel if open
  const gearBody = document.getElementById('roundSettingsBody');
  if (gearBody && gearBody.classList.contains('open')) {
    if (typeof renderRoundHistory === 'function') renderRoundHistory();
  }
    return true;
  },
  deleteProperty(target, prop) {
    delete target[prop];
    updateSummaryPageAccess();
    return true;
  }
});


let courts = 1;

function roundCourtRequiredPlayers(numCourts = courts, formats = schedulerState.courtFormats || []) {
  let required = 0;
  for (let index = 0; index < numCourts; index++) {
    required += (formats[index] || 'doubles') === 'singles' ? 2 : 4;
  }
  return required;
}

function roundEnsureCourtConfig(numCourts, totalPlayers = schedulerState.activeplayers.length) {
  if (!Array.isArray(schedulerState.courtFormats)) schedulerState.courtFormats = [];
  if (!Array.isArray(schedulerState.courtTypes)) schedulerState.courtTypes = [];

  schedulerState.courtFormats = schedulerState.courtFormats.slice(0, numCourts);
  schedulerState.courtTypes = schedulerState.courtTypes.slice(0, numCourts);

  while (schedulerState.courtFormats.length < numCourts) {
    const usedSeats = roundCourtRequiredPlayers(
      schedulerState.courtFormats.length,
      schedulerState.courtFormats
    );
    const format = usedSeats + 4 <= totalPlayers ? 'doubles' : 'singles';
    if (usedSeats + (format === 'singles' ? 2 : 4) > totalPlayers) return false;
    schedulerState.courtFormats.push(format);
    schedulerState.courtTypes.push(format === 'singles' ? 'singles-free' : 'free');
  }

  for (let index = 0; index < numCourts; index++) {
    const format = schedulerState.courtFormats[index] || 'doubles';
    schedulerState.courtFormats[index] = format;
    if (!schedulerState.courtTypes[index]) {
      schedulerState.courtTypes[index] = format === 'singles' ? 'singles-free' : 'free';
    }
  }

  return roundCourtRequiredPlayers(numCourts) <= totalPlayers;
}

function roundCanUseFormat(courtIndex, format) {
  const formats = [...(schedulerState.courtFormats || [])];
  while (formats.length < courts) formats.push('doubles');
  formats[courtIndex] = format;
  return roundCourtRequiredPlayers(courts, formats) <= schedulerState.activeplayers.length;
}

async function regenerateCurrentRoundForCourtSetup() {
  if (!allRounds.length) {
    await goToRounds();
    return;
  }

  schedulerState.numCourts = courts;
  schedulerState.courts = courts;
  const index = Math.max(0, Math.min(currentRoundIndex, allRounds.length - 1));
  const roundNumber = allRounds[index]?.round || index + 1;
  schedulerState.roundIndex = roundNumber;

  const regenerated = await safeGenerateRound(schedulerState);
  regenerated.round = roundNumber;
  allRounds[index] = regenerated;
  currentRoundIndex = index;
  if (typeof _lastRenderedRoundIndex !== 'undefined') _lastRenderedRoundIndex = -1;
  showRound(index);
  if (typeof updateCourtPills === 'function') updateCourtPills();
  if (typeof saveSnapshot === 'function') saveSnapshot();
}

async function updateCourtDisplay() {
  document.getElementById("num-courts").textContent = courts;
  updateCourtButtons(); // update both + and -
  await regenerateCurrentRoundForCourtSetup();

  const totalPlayers = schedulerState.activeplayers.length;
  const numPlayersPerRound = roundCourtRequiredPlayers();
  const numResting = Math.max(totalPlayers - numPlayersPerRound, 0);

  if (numResting >= numPlayersPerRound) {
    resetRest = true;
  } else {
    resetRest = false;
  }
	
}

async function roundAdjCourts(delta) {
  if (typeof currentState !== 'undefined' && currentState === 'active') return;
  const totalPlayers = schedulerState.activeplayers.length;
  if (delta > 0) {
    const usedSeats = roundCourtRequiredPlayers();
    if (usedSeats + 2 > totalPlayers) return;
    const format = usedSeats + 4 <= totalPlayers ? 'doubles' : 'singles';
    if (!Array.isArray(schedulerState.courtFormats)) schedulerState.courtFormats = [];
    if (!Array.isArray(schedulerState.courtTypes)) schedulerState.courtTypes = [];
    schedulerState.courtFormats[courts] = format;
    schedulerState.courtTypes[courts] = format === 'singles' ? 'singles-free' : 'free';
    courts += 1;
  } else if (delta < 0 && courts > 1) {
    courts -= 1;
    schedulerState.courtFormats = (schedulerState.courtFormats || []).slice(0, courts);
    schedulerState.courtTypes = (schedulerState.courtTypes || []).slice(0, courts);
  } else {
    return;
  }
  await updateCourtDisplay();
}

// Enable / disable buttons
function updateCourtButtons() {
  const totalPlayers = schedulerState.activeplayers.length;
  const requiredPlayers = roundCourtRequiredPlayers();

  const plusBtn = document.getElementById("courtPlus");
  const minusBtn = document.getElementById("courtMinus");
  if (!plusBtn || !minusBtn) return;

  // PLUS disable logic
  if (requiredPlayers + 2 > totalPlayers) {
    plusBtn.disabled = true;
    plusBtn.classList.add("disabled-btn");
  } else {
    plusBtn.disabled = false;
    plusBtn.classList.remove("disabled-btn");
  }

  // MINUS disable logic
  if (courts <= 1) {
    minusBtn.disabled = true;
    minusBtn.classList.add("disabled-btn");
  } else {
    minusBtn.disabled = false;
    minusBtn.classList.remove("disabled-btn");
  }
}


async function goToRounds() {
  const numCourtsInput = parseInt(document.getElementById("num-courts").textContent);
  courts = Math.max(1, numCourtsInput || 1);
  updateCourtButtons();
  //const numCourtsInput = parseInt(document.getElementById('num-courts').value);
  schedulerState.courts = numCourtsInput; // keep alias in sync for competitive_algorithm.js
  const totalPlayers = schedulerState.activeplayers.length;
  if (!totalPlayers) {
    alert('Please add players first!');
    return;
  }

  if (!numCourtsInput) {
    alert('Please enter no of Courts!');
    return;
  }  
  // Auto-calculate courts based on player count ÷ 4
  if (!roundEnsureCourtConfig(numCourtsInput, totalPlayers)) {
    alert('Not enough selected players for this court setup.');
    return;
  }
  const numCourts = numCourtsInput;
  if (!numCourts) {
    alert('Number of courts could not be determined!');
    return;
  }
  if (allRounds.length <= 1) {
    const savedFormats = [...schedulerState.courtFormats];
    const savedTypes = [...schedulerState.courtTypes];
    initScheduler(numCourts, { formats: savedFormats, types: savedTypes });
    allRounds.length = 0;
    schedulerState.roundIndex = 1; // first round starts at 1, not 0
    allRounds.push(await safeGenerateRound(schedulerState));
    if (typeof _lastRenderedRoundIndex !== 'undefined') _lastRenderedRoundIndex = -1;
    currentRoundIndex = 0;
    showRound(0);
    // Ensure live session is registered -- retries silently if it fails
    ensureLiveSession();
  } else {   
      schedulerState.numCourts = numCourts;      
      schedulerState.fixedMap = new Map();
      schedulerState.restQueue = rebuildRestQueue(schedulerState.restQueue);
      schedulerState.roundIndex = allRounds.length - 1;
      currentRoundIndex = schedulerState.roundIndex;
      const newRound = await safeGenerateRound(schedulerState);
      allRounds[allRounds.length - 1] = newRound;
      showRound(currentRoundIndex);
    }  
  /*
  document.getElementById('playersPage').style.display = 'none';
  document.getElementById('roundsPage').style.display = 'block';
  isOnPage2 = true;
  */
}

function goBack() {
  updatePlayerList();
  document.getElementById('playersPage').style.display = 'block';
  document.getElementById('roundsPage').style.display = 'none';
  isOnPage2 = false;
  const btn = document.getElementById('goToRoundsBtn');
  btn.disabled = false;
}

/* ── Ensure live session exists -- retries silently until success ── */
async function ensureLiveSession() {
  try {
    const existingId = (typeof getMySessionId === 'function') ? getMySessionId() : null;
    if (existingId) return; // already registered

    const club = (typeof getMyClub === 'function') ? getMyClub() : null;
    if (!club || !club.id) return; // no club yet -- will retry next round

    if (typeof dbStartSession === 'function') {
      await dbStartSession();
      if (typeof saveRoundsToDb       === 'function') saveRoundsToDb();
      if (typeof updateSessionLiveBar === 'function') updateSessionLiveBar();
      if (typeof startSessionHeartbeat === 'function') startSessionHeartbeat();
    }
  } catch(e) {
    console.warn('ensureLiveSession failed -- will retry next round:', e.message);
  }
}

async function nextRound() {
  // Retry live session registration in case it failed earlier
  ensureLiveSession();

  if (currentRoundIndex + 1 < allRounds.length) {
    currentRoundIndex++;
    showRound(currentRoundIndex);
  } else {
    updSchedule(allRounds.length - 1, schedulerState); // pass schedulerState
    schedulerState.roundIndex = (schedulerState.roundIndex || 0) + 1; // increment once, right before generating
    let newRound;
    try {
      newRound = await safeGenerateRound(schedulerState); // do NOT wrap in []
    } catch (error) {
      // A complete uniqueness cycle is expected, not a generation failure.
      // Keep every completed round, clear only cycle-specific repetition
      // tracking, then generate the next numbered round immediately.
      if (schedulerState.uniqueGamesMode && error?.code === 'UNIQUE_CYCLE_EXHAUSTED') {
        resetUniqueRoundCycleKeepingSetup(schedulerState);
        newRound = await safeGenerateRound(schedulerState);
      } else {
        throw error;
      }
    }
    // Fixed-pair schedules can exhaust their reachable unique games long before
    // the theoretical all-player combination count. If the worker can only
    // return a match already used in this cycle, start a fresh round cycle and
    // regenerate while retaining players, fixed pairs and court setup.
    if (schedulerState.uniqueGamesMode && roundContainsKnownMatch(newRound, schedulerState)) {
      resetUniqueRoundCycleKeepingSetup(schedulerState);
      newRound = await safeGenerateRound(schedulerState);
    }
    allRounds.push(newRound);
    currentRoundIndex = allRounds.length - 1;
    showRound(currentRoundIndex);
    if (typeof saveRoundsToDb === 'function') saveRoundsToDb();
  }
  updateSummaryPageAccess();
  // Note: saveSnapshot called from toggleRound after state fully settled
}
async function endRounds() {  
	sessionFinished = true;
	updSchedule(allRounds.length - 1, schedulerState, false); // false = don't sync ratings again
    const newRound = await safeGenerateRound(schedulerState); // do NOT wrap in []
    allRounds.push(newRound);
    currentRoundIndex = allRounds.length - 2;
    showRound(currentRoundIndex);
	
	// pass schedulerState              
	// Disable Next & Refresh
  document.getElementById("nextBtn").disabled = true;
  document.getElementById("roundShufle").disabled = true;

  // Optional: also disable End to prevent double-click
  document.getElementById("endBtn").disabled = true;
	updateSummaryPageAccess();
	showPage('summaryPage');

	
}
function prevRound() {
  if (currentRoundIndex > 0) {
    currentRoundIndex--;
    showRound(currentRoundIndex);
  }
}

function initScheduler(numCourts, courtConfig = null) {
  schedulerState.numCourts   = numCourts;
  schedulerState.courts      = numCourts;
  schedulerState.roundIndex  = 0;

  schedulerState.restCount      = new Map(schedulerState.activeplayers.map(p => [p, 0]));
  schedulerState.PlayedCount    = new Map(schedulerState.activeplayers.map(p => [p, 0]));
  schedulerState.typePlayCount  = { MD: new Map(), LD: new Map(), XD: new Map() };
  schedulerState.PlayerScoreMap = new Map(schedulerState.activeplayers.map(p => [p, 0]));
  schedulerState.winCount       = new Map(schedulerState.activeplayers.map(p => [p, 0]));
  schedulerState.rankPoints     = new Map(schedulerState.activeplayers.map(p => [p, 100]));
  schedulerState.streakMap      = new Map(schedulerState.activeplayers.map(p => [p, 0]));

  schedulerState.playedTogether = new Map();
  schedulerState.fixedMap       = new Map();
  schedulerState.pairPlayedSet  = new Set();
  schedulerState.gamesMap       = new Set();
  schedulerState.courtTypes = courtConfig?.types
    ? courtConfig.types.slice(0, numCourts)
    : [];
  schedulerState.courtFormats = courtConfig?.formats
    ? courtConfig.formats.slice(0, numCourts)
    : [];

  // New algorithm state
  schedulerState.pairHistory    = new Map();   // _pairKey -> times played together
  schedulerState.reachablePairs = new Set();   // all pairs that could ever play

  // Initialize opponentMap
  schedulerState.opponentMap = new Map();
  for (const p1 of schedulerState.activeplayers) {
    const innerMap = new Map();
    for (const p2 of schedulerState.activeplayers) {
      if (p1 !== p2) innerMap.set(p2, 0);
    }
    schedulerState.opponentMap.set(p1, innerMap);
  }

  // Fixed pairs lookup
  schedulerState.fixedPairs.forEach(([a, b]) => {
    schedulerState.fixedMap.set(a, b);
    schedulerState.fixedMap.set(b, a);
  });

  // Build rest queue sorted weak-to-strong (once at session start)
  // FIFO rotation takes over from here naturally
  schedulerState.restQueue = createRestQueue();
}


function updateScheduler() {
  schedulerState.opponentMap = new Map();
  for (const p1 of schedulerState.activeplayers) {
    const innerMap = new Map();
    for (const p2 of schedulerState.activeplayers) {
      if (p1 !== p2) innerMap.set(p2, 0);
    }
    schedulerState.opponentMap.set(p1, innerMap);
  }

  // Reset new algorithm state on court change
  schedulerState.pairHistory    = new Map();
  schedulerState.reachablePairs = new Set();

  schedulerState.restQueue = rebuildRestQueue(schedulerState.restQueue);
}

/* ================================
   🔁 1-3-2-4 QUEUE REORDER (GUARDED)
================================ */
function reorder1324(queue, roundIndex = 0) {
  const total = queue.length;

  if (total < 4 || total % 2 !== 0) {
    return queue.slice();
  }

  // 1️⃣ split into pairs
  const pairs = [];
  for (let i = 0; i < total; i += 2) {
    pairs.push([queue[i], queue[i + 1]]);
  }

  const pCount = pairs.length;

  // 2️⃣ 4 or 6 pairs (8 / 12 players)
  if (pCount === 4 || pCount === 6) {
    const size = Math.floor(pCount / 4);

    const g1 = pairs.slice(0, size);
    const g2 = pairs.slice(size, size * 2);
    const g3 = pairs.slice(size * 2, size * 3);
    const g4 = pairs.slice(size * 3);

    // deterministic rotations (no randomness)
    const patterns = [
      [g1, g4, g2, g3], // 1-4-2-3
      [g2, g1, g4, g3], // rotate
      [g3, g2, g1, g4], // rotate
    ];

    const pattern = patterns[roundIndex % patterns.length];
    return pattern.flat().flat();
  }

  // 3️⃣ 8+ pairs (16+ players)
  if (pCount >= 8) {
    const size = Math.floor(pCount / 8);
    const groups = [];

    for (let i = 0; i < 8; i++) {
      groups.push(pairs.slice(i * size, (i + 1) * size));
    }

    const patterns = [
      [0, 2, 4, 6, 1, 3, 5, 7],
      [1, 3, 5, 7, 2, 4, 6, 0],
      [2, 4, 6, 0, 3, 5, 7, 1],
      [3, 5, 7, 1, 4, 6, 0, 2],
    ];

    const order = patterns[roundIndex % patterns.length];
    return order.flatMap(i => groups[i]).flat();
  }

  // 4️⃣ fallback → rotate pairs by roundIndex
  const offset = roundIndex % pCount;
  return [...pairs.slice(offset), ...pairs.slice(0, offset)].flat();
}




// 🔍 check if ALL pairs exhausted
function allPairsExhausted(queue, pairPlayedSet) {
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const key = [queue[i], queue[j]].sort().join("&");
      if (!pairPlayedSet.has(key)) return false;
    }
  }
  return true;
}




/* ============================================================
   QC MODULE — validateRound
   Validates a round before rendering.
   Hard fails → regenerate with random fallback
   Soft fails → log only
============================================================ */
function _pairKey(a, b) { return [a, b].sort().join('&'); }

function validateRound(round, schedulerState) {
  const hardFails = [];
  const softFails = [];

  if (!round || !round.games) {
    hardFails.push('No games in round');
    return { valid: false, hardFails, softFails };
  }

  const { games, playing } = round;
  const { numCourts, fixedPairs } = schedulerState;

  // ── Hard Check 1: Court count ──
  if (games.length !== numCourts) {
    hardFails.push(`Court count mismatch: got ${games.length}, expected ${numCourts}`);
  }

  // ── Hard Check 2: Doubles is 2v2; Singles is 1v1 ──
  const courtFormats = schedulerState.courtFormats || [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const courtIndex = Number.isFinite(Number(g.court))
      ? Math.max(0, Number(g.court) - 1)
      : i;
    const format = courtFormats[courtIndex] || 'doubles';
    const expectedPairSize = format === 'singles' ? 1 : 2;
    if (!g.pair1 || g.pair1.length !== expectedPairSize) {
      hardFails.push(`Court ${courtIndex + 1}: pair1 invalid for ${format}`);
    }
    if (!g.pair2 || g.pair2.length !== expectedPairSize) {
      hardFails.push(`Court ${courtIndex + 1}: pair2 invalid for ${format}`);
    }
  }

  // ── Hard Check 3: No duplicate players across courts ──
  const allCourtPlayers = games.flatMap(g => [...(g.pair1||[]), ...(g.pair2||[])]);
  const seen = new Set();
  for (const p of allCourtPlayers) {
    if (seen.has(p)) hardFails.push(`Duplicate player in courts: ${p}`);
    seen.add(p);
  }

  // ── Hard Check 4: playing/resting agree with court assignments ──
  if (playing && playing.length) {
    const playingSeen = new Set();
    for (const p of playing) {
      if (!seen.has(p)) hardFails.push(`Playing player missing from courts: ${p}`);
      if (playingSeen.has(p)) hardFails.push(`Duplicate player in playing list: ${p}`);
      playingSeen.add(p);
    }
  }
  const restingSeen = new Set();
  for (const restingPlayer of (round.resting || [])) {
    const baseName = String(restingPlayer).split('#')[0];
    if (restingSeen.has(baseName)) hardFails.push(`Duplicate player in resting list: ${baseName}`);
    if (seen.has(baseName)) hardFails.push(`Player appears in a court and resting list: ${baseName}`);
    restingSeen.add(baseName);
  }

  // ── Hard Check 5: Fixed pairs intact ──
  if (fixedPairs && fixedPairs.length) {
    const restingSet = new Set((round.resting || []).map(r => r.split('#')[0]));
    for (const [a, b] of fixedPairs) {
      // Skip if both resting
      if (restingSet.has(a) && restingSet.has(b)) continue;
      // If both playing, must be together as a pair
      if (!restingSet.has(a) && !restingSet.has(b)) {
        const together = games.some(g =>
          (g.pair1 && g.pair1.includes(a) && g.pair1.includes(b)) ||
          (g.pair2 && g.pair2.includes(a) && g.pair2.includes(b))
        );
        if (!together) hardFails.push(`Fixed pair split: ${a} & ${b}`);
      }
    }
  }

  // ── Hard Check 6: No repeated match from previous rounds ──
  const { gamesMap } = schedulerState;
  if (gamesMap && gamesMap.size > 0) {
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      if (!g.pair1 || !g.pair2) continue;
      const p1key = g.pair1.slice().sort().join('&');
      const p2key = g.pair2.slice().sort().join('&');
      const matchKey = [p1key, p2key].sort().join(':');
      if (gamesMap.has(matchKey)) {
        hardFails.push(`Court ${i+1} repeated match: ${g.pair1.join('+')} vs ${g.pair2.join('+')}`);
      }
    }
  }

  // ── Soft Check 7: Rating balance ──
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (!g.pair1 || !g.pair2) continue;
    const avg1 = g.pair1.reduce((s, p) => {
      const r = typeof getActiveRating === 'function' ? getActiveRating(p) : 1.0;
      return s + (Number.isFinite(r) ? r : 1.0);
    }, 0) / g.pair1.length;
    const avg2 = g.pair2.reduce((s, p) => {
      const r = typeof getActiveRating === 'function' ? getActiveRating(p) : 1.0;
      return s + (Number.isFinite(r) ? r : 1.0);
    }, 0) / g.pair2.length;
    if (Math.abs(avg1 - avg2) > 1.0) {
      softFails.push(`Court ${i+1} rating imbalance: ${avg1.toFixed(1)} vs ${avg2.toFixed(1)}`);
    }
  }

  if (softFails.length) console.warn('QC soft fails:', softFails);

  return { valid: hardFails.length === 0, hardFails, softFails };
}

/* ── Run QC and retry if hard fail ── */
/* ================================================================
   safeGenerateRound — async, calls Cloudflare Worker
   Worker ONLY generates games/resting/playing.
   ALL schedulerState variables (Maps, Sets, etc.) stay in JS
   and are updated by updSchedule exactly as before.
   ================================================================ */

function buildWorkerHistorySnapshot(state) {
  const serializeNestedMap = map => {
    const out = [];
    if (map instanceof Map) {
      for (const [key, inner] of map.entries()) {
        out.push([key, inner instanceof Map ? [...inner.entries()] : []]);
      }
    }
    return out;
  };

  const typePlayCount = state.typePlayCount || {};
  const singles = new Map((state.activeplayers || []).map(name => [name, 0]));
  for (const round of (allRounds || [])) {
    for (const game of (round.games || [])) {
      if ((game.pair1 || []).length === 1 && (game.pair2 || []).length === 1) {
        for (const name of [...game.pair1, ...game.pair2]) {
          singles.set(name, (singles.get(name) || 0) + 1);
        }
      }
    }
  }

  return {
    playedCount: state.PlayedCount instanceof Map ? [...state.PlayedCount.entries()] : [],
    restCount: state.restCount instanceof Map ? [...state.restCount.entries()] : [],
    restQueue: Array.isArray(state.restQueue) ? [...state.restQueue] : [],
    gameTypeCounts: {
      MD: typePlayCount.MD instanceof Map ? [...typePlayCount.MD.entries()] : [],
      LD: typePlayCount.LD instanceof Map ? [...typePlayCount.LD.entries()] : [],
      XD: typePlayCount.XD instanceof Map ? [...typePlayCount.XD.entries()] : [],
      singles: [...singles.entries()],
    },
    pairPlayedSet: state.pairPlayedSet instanceof Set ? [...state.pairPlayedSet] : [],
    gamesMap: state.gamesMap instanceof Set ? [...state.gamesMap] : [],
    opponentMap: serializeNestedMap(state.opponentMap),
    previousRound: (allRounds && allRounds.length) ? allRounds[allRounds.length - 1] : null,
  };
}

function applyWorkerHistorySnapshot(state, snapshot) {
  if (!snapshot) return;
  if (Array.isArray(snapshot.playedCount)) state.PlayedCount = new Map(snapshot.playedCount);
  if (Array.isArray(snapshot.restCount)) state.restCount = new Map(snapshot.restCount);
  if (Array.isArray(snapshot.restQueue)) state.restQueue = [...snapshot.restQueue];
  if (Array.isArray(snapshot.pairPlayedSet)) state.pairPlayedSet = new Set(snapshot.pairPlayedSet);
  if (Array.isArray(snapshot.gamesMap)) state.gamesMap = new Set(snapshot.gamesMap);
  if (Array.isArray(snapshot.opponentMap)) {
    state.opponentMap = new Map(snapshot.opponentMap.map(([p, inner]) => [p, new Map(inner || [])]));
  }
  if (!state.typePlayCount) state.typePlayCount = { MD: new Map(), LD: new Map(), XD: new Map() };
  const counts = snapshot.gameTypeCounts || {};
  for (const type of ['MD', 'LD', 'XD']) {
    if (Array.isArray(counts[type])) state.typePlayCount[type] = new Map(counts[type]);
  }
}

async function safeGenerateRound(state) {
  // Sync uniqueGamesMode from toggle
  if (typeof getUniqueGamesMode === 'function') {
    state.uniqueGamesMode = getUniqueGamesMode();
  }

  // ── Verify subscription token is still valid before generating ──
  const email = typeof authGetEmail === 'function' ? authGetEmail() : null;
  if (email && typeof _refreshTokenIfNeeded === 'function') {
    await _refreshTokenIfNeeded(email);
  }
  if (typeof canAccessMode === 'function' && !canAccessMode('organiser')) {
    if (typeof showModeUpgradePrompt === 'function') showModeUpgradePrompt('organiser');
    throw new Error('Subscription required');
  }

  // ── Serialize only what the Worker needs to generate the round ──

  // opponentMap: Map<name, Map<name, count>> → [[name, [[opp,count]]]]
  const opponentMapSerial = [];
  if (state.opponentMap instanceof Map) {
    for (const [p, inner] of state.opponentMap) {
      opponentMapSerial.push([p, [...inner.entries()]]);
    }
  }

  // restCount: Map<name, count> → [[name, count]]
  const restCountSerial = state.restCount instanceof Map
    ? [...state.restCount.entries()]
    : [];

  // playedCount is sent separately so participation fairness is never mixed
  // with pair/game freshness or game-type balancing.
  const playedCountSerial = state.PlayedCount instanceof Map
    ? [...state.PlayedCount.entries()]
    : [];

  // restQueue: plain array of player names
  const restQueueSerial = Array.isArray(state.restQueue)
    ? [...state.restQueue]
    : [];

  // pairPlayedSet: Set<string> → [string]
  const pairPlayedSetSerial = state.pairPlayedSet instanceof Set
    ? [...state.pairPlayedSet]
    : [];

  // gamesMap: Set<string> → [string]
  const gamesMapSerial = state.gamesMap instanceof Set
    ? [...state.gamesMap]
    : [];

  // allPlayers for rating/gender lookups in competitive mode
  const allPlayersSerial = (state.allPlayers || []).map(p => ({
    name:       p.name,
    gender:     p.gender     || null,
    rating:     (p.guest || p.unrated) ? null : (p.rating || 1.0),
    clubRating: (p.guest || p.unrated) ? null : (p.clubRating || null),
    guest:      !!p.guest,
    unrated:    !!p.unrated,
  }));

  const playMode = (typeof getPlayMode === 'function') ? getPlayMode() : 'random';

  // Build the explicit top-down game requirement requested by the UI.
  const requiredGames = {
    mensDoubles: 0,
    womensDoubles: 0,
    mixedDoubles: 0,
    freeDoubles: 0,
    mensSingles: 0,
    womensSingles: 0,
    freeSingles: 0,
    singles: 0,
    doubles: 0,
  };
  (state.courtFormats || []).forEach(function(fmt, i) {
    const type = (state.courtTypes || [])[i] || (fmt === 'singles' ? 'singles-free' : 'free');
    if (fmt === 'singles') {
      requiredGames.singles++;
      if (type === 'singles-men' || type === 'MD' || type === 'men') requiredGames.mensSingles++;
      else if (type === 'singles-women' || type === 'LD' || type === 'women') requiredGames.womensSingles++;
      else requiredGames.freeSingles++;
    } else {
      requiredGames.doubles++;
      if (type === 'MD') requiredGames.mensDoubles++;
      else if (type === 'LD') requiredGames.womensDoubles++;
      else if (type === 'XD') requiredGames.mixedDoubles++;
      else requiredGames.freeDoubles++;
    }
  });

  const gameTypeCountSerial = { MD: [], LD: [], XD: [], singles: [] };
  const typePlayCount = state.typePlayCount || {};
  for (const type of ['MD', 'LD', 'XD']) {
    const map = typePlayCount[type];
    gameTypeCountSerial[type] = map instanceof Map ? [...map.entries()] : [];
  }
  // Singles counts are reconstructed from completed rounds so the worker has
  // one explicit history contract for all requested formats.
  const singlesMap = new Map((state.activeplayers || []).map(p => [p, 0]));
  for (const round of (allRounds || [])) {
    for (const game of (round.games || [])) {
      if ((game.pair1 || []).length === 1 && (game.pair2 || []).length === 1) {
        for (const player of [...game.pair1, ...game.pair2]) {
          singlesMap.set(player, (singlesMap.get(player) || 0) + 1);
        }
      }
    }
  }
  gameTypeCountSerial.singles = [...singlesMap.entries()];

  const historySnapshot = buildWorkerHistorySnapshot(state);

  const payload = {
    history:                historySnapshot,
    activeplayers:          [...(state.activeplayers || [])],
    numCourts:              state.numCourts,
    courts:                 state.courts || state.numCourts,
    fixedPairs:             state.fixedPairs || [],
    restQueue:              restQueueSerial,
    restCount:              restCountSerial,
    playedCount:            playedCountSerial,
    opponentMap:            opponentMapSerial,
    pairPlayedSet:          pairPlayedSetSerial,
    gamesMap:               gamesMapSerial,
    allRounds:              (allRounds || []), // top-down fairness and freshness always require complete history // competitive + unique games + MBM + typed/singles courts need history
    playMode:               playMode,
    minRounds:              state.minRounds || 6,
    lastMode:               state._lastMode || null,
    allPlayers:             allPlayersSerial,
    roundIndex:             state.roundIndex || 0,
    fixedPairGameQueue:     state.fixedPairGameQueue     || null,
    fixedPairGameQueueHash: state.fixedPairGameQueueHash || null,
    courtTypes:             state.courtTypes   || [],
    courtFormats:           state.courtFormats || [],
    uniqueGamesMode:        state.uniqueGamesMode || false,
    balancedMode:           (typeof getGameGenerationMode === 'function' && getGameGenerationMode() === 'balanced'),
    topDownStandardMode:    !state.uniqueGamesMode && playMode !== 'competitive',
    requiredGames:          requiredGames,
    gameTypeCounts:         gameTypeCountSerial,
    _mbmCall:               state._mbmCall      || false,
    _mbmWaitQueue:          state._mbmWaitQueue || [],
  };

  let resp;
  try {
    const res = await fetch(WORKER_URL + '/generate-round', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('Worker ' + res.status + ': ' + errText);
    }
    resp = await res.json();
  } catch(e) {
    console.error('safeGenerateRound Worker error:', e);
    alert('Round generation failed — please check connection.\n' + e.message);
    throw e;
  }

  // ── Worker returns { games, resting, playing, roundIndex, lastMode } ──
  // NOTE: Do NOT use resp.roundIndex to update state.roundIndex.
  // The worker increments roundIndex on every internal retry attempt, causing
  // the displayed round number to jump (e.g. Round 35 → Round 38).
  // The caller always sets the correct roundIndex before calling safeGenerateRound.
  if (resp.lastMode) state._lastMode = resp.lastMode;

  // ── Validate court count ──
  const expectedCourts = state.numCourts || 1;
  const returnedGames  = resp.games || [];
  if (returnedGames.length < expectedCourts) {
    console.warn('Worker returned', returnedGames.length, 'courts, expected', expectedCourts);
    // Don't throw — return what we got, caller can handle partial
  }

  // ── Return same shape as original AischedulerNextRound ──
  const generatedRound = {
    round:   state.roundIndex, // use caller's roundIndex, not worker's
    games:   returnedGames,
    resting: resp.resting || [],
    playing: resp.playing || [],
    _workerNextHistory: resp.nextHistory || null,
    _workerValidation: resp.validation || null,
  };

  // Never render a stale/invalid Worker response. In particular, an older
  // Worker may label a court Singles while still returning a 2v2 game, which
  // can also duplicate those players in another court or in the resting list.
  const quality = validateRound(generatedRound, state);
  if (!quality.valid) {
    const details = quality.hardFails.join('; ');
    console.error('Worker returned an invalid round:', details, generatedRound);
    const repeatsOnly = quality.hardFails.length > 0 &&
      quality.hardFails.every(message => message.includes('repeated match'));
    const error = new Error(
      (repeatsOnly ? 'Unique round cycle exhausted: ' : 'Worker update required: ') + details
    );
    error.code = repeatsOnly ? 'UNIQUE_CYCLE_EXHAUSTED' : 'INVALID_WORKER_ROUND';
    throw error;
  }

  return generatedRound;
}

function updSchedule(roundIndex, schedulerState, syncToDb = true) {
  //AUTO_SAVE();
	const data = allRounds[roundIndex];
  if (!data) return;

  const { games, resting } = data;
  const {
    restCount,
    PlayedCount,
    PlayerScoreMap,
    opponentMap,
    pairPlayedSet,
	gamesMap,
    playedTogether, // <<-- Missing in your version
  } = schedulerState;

  // 1️⃣ Update rest count
  for (const p of resting) {
    const playerName = p.split('#')[0];
    restCount.set(playerName, (restCount.get(playerName) || 0) + 1);
  }
   
// Helper → base name
const base = p => p.split('#')[0];

// 1️⃣ COPY restQueue first (so we don't modify during loop)
let newQueue = schedulerState.restQueue.slice();

// 2️⃣ FULL REMOVE: strip any players whose base name matches resting
for (const r of resting) {
  const b = base(r);
  newQueue = newQueue.filter(q => base(q) !== b);
}

// Replace restQueue after ALL removals done
schedulerState.restQueue = newQueue;

// 3️⃣ FULL ADD: now add base names of ALL resting at once
for (const r of resting) {
  schedulerState.restQueue.push(base(r));
}    

  // 2️⃣ Update PlayedCount
  lastRound.length = 0; // 🔥 reset global array (keeps reference)

for (const [gi, game] of games.entries()) {
  const allPlayers = [...game.pair1, ...game.pair2];

  lastRound.push(...allPlayers);

  for (const p of allPlayers) {
    PlayedCount.set(p, (PlayedCount.get(p) || 0) + 1);
    // Track per-type play count
    const _type = (schedulerState.courtTypes || [])[gi] || 'free';
    if (_type === 'MD' || _type === 'LD' || _type === 'XD') {
      if (!schedulerState.typePlayCount) schedulerState.typePlayCount = { MD: new Map(), LD: new Map(), XD: new Map() };
      const _tmap = schedulerState.typePlayCount[_type];
      _tmap.set(p, (_tmap.get(p) || 0) + 1);
    }
  }
}

  // 3️⃣ Update opponentMap & PlayerScoreMap
  for (const game of games) {
    const { pair1, pair2 } = game;

    // Ensure maps exist (prevents null errors)
    for (const a of [...pair1, ...pair2]) {
      if (!opponentMap.has(a)) opponentMap.set(a, new Map());
    }

    // Opponent tracking
    for (const a of pair1) {
      for (const b of pair2) {
        opponentMap.get(a).set(b, (opponentMap.get(a).get(b) || 0) + 1);
        opponentMap.get(b).set(a, (opponentMap.get(b).get(a) || 0) + 1);
      }
    }

    // Score calculation (new opponents bonus)
    for (const group of [pair1, pair2]) {
      for (const player of group) {
        let newOpponents = 0;
        const rivals = group === pair1 ? pair2 : pair1;

        for (const r of rivals) {
          if (opponentMap.get(player).get(r) === 1) newOpponents++;
        }

        const score = newOpponents === 2 ? 2 : newOpponents === 1 ? 1 : 0;
        PlayerScoreMap.set(player, (PlayerScoreMap.get(player) || 0) + score);
      }
    }
  }

  // 4️⃣ Track pairs played together (with round info)
  for (const game of games) {
    for (const pr of [game.pair1, game.pair2]) {
      const key = pr.slice().sort().join("&");
      pairPlayedSet.add(key);
      playedTogether.set(key, roundIndex); // <<-- IMPORTANT FIX
    }
  }

    // 4️⃣ Track pairs played together (with round info)
  for (const game of games) {
  const p1 = game.pair1.slice().sort().join("&");
  const p2 = game.pair2.slice().sort().join("&");

  // ensure A&B:C&D === C&D:A&B
  const gameKey = [p1, p2].sort().join(":");

  gamesMap.add(gameKey);
}

/// 7️⃣ 🏆 Update WIN COUNT + RATINGS
// Win counts always tracked regardless of mode
for (const game of games) {
  if (!game.winner) continue;
  const winners = game.winner === 'L' ? game.pair1 : game.pair2;
  for (const p of winners) {
    schedulerState.winCount.set(p, (schedulerState.winCount.get(p) || 0) + 1);
  }
}

// Rating updates -- DUPR-style individual player formula
// Each player's delta depends on their own rating vs opponent average
// K = 0.45 (max swing), spread = 1.5 (curve steepness)
const RATING_K      = 0.45;
const RATING_SPREAD = 1.5;

const roundWins         = new Map();
const roundLosses       = new Map();
const roundRatingDeltas = new Map(); // uncapped delta for points
function _roundIsGuestPlayer(name) {
  const key = String(name || '').trim().toLowerCase();
  const p = (schedulerState.allPlayers || []).find(pl => String(pl.name || '').trim().toLowerCase() === key);
  return !!(p && (p.guest || p.unrated)) || /\(guest(?:\s+[a-z0-9]+)?\)$/i.test(String(name || ''));
}

for (const game of games) {
  if (!game.winner) continue;

  const winners = game.winner === 'L' ? game.pair1 : game.pair2;
  const losers  = game.winner === 'L' ? game.pair2 : game.pair1;
  const hasGuest = winners.concat(losers).some(_roundIsGuestPlayer);
  if (hasGuest) {
    winners.forEach(p => { if (!_roundIsGuestPlayer(p)) roundWins.set(p, (roundWins.get(p) || 0) + 1); });
    losers.forEach(p => { if (!_roundIsGuestPlayer(p)) roundLosses.set(p, (roundLosses.get(p) || 0) + 1); });
    continue;
  }

  // Opponent averages (used individually per player)
  const winAvg  = winners.reduce((s, p) => s + (typeof getActiveRating === "function" ? getActiveRating(p) : getRating(p)), 0) / winners.length;
  const loseAvg = losers.reduce((s, p)  => s + (typeof getActiveRating === "function" ? getActiveRating(p) : getRating(p)), 0) / losers.length;

  // Each winner: delta = K * (1 - expected)
  // Lower-rated winner vs strong opponents → higher reward
  for (const p of winners) {
    const myRating = typeof getActiveRating === "function" ? getActiveRating(p) : getRating(p);
    const expected = 1 / (1 + Math.pow(10, (loseAvg - myRating) / RATING_SPREAD));
    const delta    = Math.round(RATING_K * (1 - expected) * 100) / 100;
    setRating(p, myRating + delta);
    roundWins.set(p, (roundWins.get(p) || 0) + 1);
    roundRatingDeltas.set(p, (roundRatingDeltas.get(p) || 0) + delta);
  }

  // Each loser: delta = -K * expected
  // Higher-rated loser vs weak opponents → bigger penalty
  for (const p of losers) {
    const myRating = typeof getActiveRating === "function" ? getActiveRating(p) : getRating(p);
    const expected = 1 / (1 + Math.pow(10, (winAvg - myRating) / RATING_SPREAD));
    const delta    = Math.round(RATING_K * expected * 100) / 100;
    const updated  = Math.max(1.0, myRating - delta);
    setRating(p, updated);
    roundLosses.set(p, (roundLosses.get(p) || 0) + 1);
    roundRatingDeltas.set(p, (roundRatingDeltas.get(p) || 0) - delta);
  }
}

  // ── Update pairHistory + opponentMap for new algorithm ──
  if (!schedulerState.pairHistory) schedulerState.pairHistory = new Map();
  for (const game of games) {
    const k1 = _pairKey(game.pair1[0], game.pair1[1]);
    const k2 = _pairKey(game.pair2[0], game.pair2[1]);
    schedulerState.pairHistory.set(k1, (schedulerState.pairHistory.get(k1) || 0) + 1);
    schedulerState.pairHistory.set(k2, (schedulerState.pairHistory.get(k2) || 0) + 1);
  }

// Refresh all visible badges
syncRatings();
updatePlayerList();

// Sync ratings + wins/losses to Supabase (only from nextRound, not endRounds)
if (syncToDb && typeof syncAfterRound === "function") syncAfterRound(roundWins, roundLosses, roundRatingDeltas);

// after tracking pairs & games
checkAndResetPairCycle(schedulerState, games, roundIndex);
	// ✅ EXECUTE ONLY WHEN BOTH CONDITIONS ARE TRUE
if ( resetRest === true &&
  allPairsExhausted(schedulerState.restQueue, pairPlayedSet)
) {
  schedulerState.restQueue = reorder1324(schedulerState.restQueue);

  // optional: prevent repeated execution
  //schedulerState.resetRest = false;
}

// The main app owns memory. After accepting the round, replace the core
// scheduling counters with the stateless Worker's returned next snapshot.
// This snapshot is sent back unchanged on the next generation request.
applyWorkerHistorySnapshot(schedulerState, data._workerNextHistory);
schedulerState._lastWorkerValidation = data._workerValidation || null;
}

function createRestQueue() {
  // Return active players in their input order.
  // FIFO rotation handles fair rest distribution from here.
  return [...schedulerState.activeplayers];
}

function rebuildRestQueue(restQueue) {
  const newQueue = [];
  const active = schedulerState.activeplayers;

  // 1. Add active players based on the order in old restQueue
  for (const p of restQueue) {
    if (active.includes(p)) {
      newQueue.push(p);
    }
  }

  // 2. Add any newly active players not found in old restQueue
  for (const p of active) {
    if (!newQueue.includes(p)) {
      newQueue.push(p);
    }
  }

  return newQueue;
}




  

async function RefreshRound() {
    // Save current position - shuffle must NOT change round number or advance index
    const savedRoundIndex = schedulerState.roundIndex;
    const savedCurrentIndex = currentRoundIndex;

    // Generate a new arrangement for the CURRENT round only
    // Route by mode: competitive re-runs the rating-aware scheduler,
    // random uses the pure random shuffle
    let newRound;
    if (typeof getPlayMode === 'function' && getPlayMode() === 'competitive') {
      // In competitive mode the scheduler is deterministic, so we temporarily
      // mark the current round's pairs as 'used'. This forces the algorithm
      // to find a genuinely different balanced arrangement.
      // We restore pairPlayedSet immediately after so state is unchanged.
      const currentRound = allRounds[currentRoundIndex];
      const tempKeys = [];
      if (currentRound && currentRound.games) {
        for (const game of currentRound.games) {
          for (const pair of [game.pair1, game.pair2]) {
            const key = [...pair].sort().join('&');
            if (!schedulerState.pairPlayedSet.has(key)) {
              schedulerState.pairPlayedSet.add(key);
              tempKeys.push(key);
            }
          }
        }
      }
      newRound = await safeGenerateRound(schedulerState);
      // Restore: remove the temporarily added keys
      for (const key of tempKeys) {
        schedulerState.pairPlayedSet.delete(key);
      }
    } else {
      // If any courts have typed assignments, use worker (typedRound)
      // Otherwise use fast client-side RandomRound
      const hasTyped = (schedulerState.courtTypes || []).some(t => t && t !== 'free') ||
                       (schedulerState.courtFormats || []).some(f => f === 'singles');
      if (hasTyped) {
        // Temporarily mark current pairs as used to force fresh pairs
        const currentRound = allRounds[currentRoundIndex];
        const tempKeys = [];
        if (currentRound && currentRound.games) {
          for (const game of currentRound.games) {
            for (const pair of [game.pair1, game.pair2]) {
              const key = [...pair].sort().join('&');
              if (!schedulerState.pairPlayedSet.has(key)) {
                schedulerState.pairPlayedSet.add(key);
                tempKeys.push(key);
              }
            }
          }
        }
        newRound = await safeGenerateRound(schedulerState);
        // Restore pairPlayedSet
        for (const key of tempKeys) {
          schedulerState.pairPlayedSet.delete(key);
        }
      } else {
        newRound = RandomRound(schedulerState);
      }
    }

    // Keep the round number exactly the same as before
    newRound.round = savedRoundIndex;

    // If worker returned fewer courts than expected, fill missing with RandomRound
    const expectedCourts = schedulerState.numCourts || 1;
    if (newRound.games && newRound.games.length < expectedCourts) {
      console.warn('Partial round — falling back to RandomRound for missing courts');
      const fallback = RandomRound(schedulerState);
      if (fallback && fallback.games) {
        while (newRound.games.length < expectedCourts && fallback.games.length > 0) {
          newRound.games.push(fallback.games.shift());
        }
      }
    }

    // Restore everything - no advancement
    schedulerState.roundIndex = savedRoundIndex;
    currentRoundIndex = savedCurrentIndex;

    // Replace current round in-place
    allRounds[currentRoundIndex] = newRound;
    showRound(currentRoundIndex);
    if (typeof saveSnapshot     === 'function') saveSnapshot();
    if (typeof saveRoundsToDb   === 'function') saveRoundsToDb();
}

function ratingToColor(r) {
  if (r < 2.0) return "#9e9e9e";  // grey  -- beginner
  if (r < 3.0) return "#4a9eff";  // blue  -- developing
  if (r < 4.0) return "#2dce89";  // green -- intermediate
  if (r < 4.5) return "#f5a623";  // amber -- advanced
  return "#e63757";                // red   -- elite
}

function report() {
  const container = document.getElementById("reportContainer");
  if (!container) return;
  container.innerHTML = "";

  // Guard: nothing to show if no players in session
  if (!schedulerState.allPlayers || schedulerState.allPlayers.length === 0) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:0.9rem;">' + t('noSessionData') + '</div>';
    return;
  }

  const playMode = getPlayMode(); // "competitive" | "random"

  /* ===== HEADER ===== */
  const header = document.createElement("div");
  header.className = "report-header";
  header.innerHTML = `
    <div class="header-strip"></div>
    <div class="header-rank">Rank</div>
    <div class="header-name">Name</div>
    <div class="header-wins">W</div>
    <div class="header-played">P</div>
    <div class="header-rested">R</div>
  `;
  container.appendChild(header);

  /* ===== SORT LOGIC ===== */
  let sortedPlayers = [...schedulerState.allPlayers];

  if (playMode === "competitive") {
    // 🔥 PURE WINS LADDER
    sortedPlayers.sort((a, b) => {
      const wA = schedulerState.winCount.get(a.name) || 0;
      const wB = schedulerState.winCount.get(b.name) || 0;
      return wB - wA;
    });
  } else {
    // 🎲 EXISTING FAIRNESS MODE
    sortedPlayers.sort((a, b) => {
      const playedA = schedulerState.PlayedCount.get(a.name) || 0;
      const playedB = schedulerState.PlayedCount.get(b.name) || 0;
      if (playedB !== playedA) return playedB - playedA;

      const restA = schedulerState.restCount.get(a.name) || 0;
      const restB = schedulerState.restCount.get(b.name) || 0;
      return restB - restA;
    });
  }

  /* ===== RENDER ===== */
  sortedPlayers.forEach((p, index) => {
    const wins = schedulerState.winCount.get(p.name) || 0;
    const played = schedulerState.PlayedCount.get(p.name) || 0;
    const rest = schedulerState.restCount.get(p.name) || 0;
    const isGuest = !!(p.guest || p.unrated) || /\(guest(?:\s+[a-z0-9]+)?\)$/i.test(String(p.name || ''));

    const rating   = isGuest ? null : ((typeof getRating === 'function') ? (typeof getActiveRating === "function" ? getActiveRating(p.name) : getRating(p.name)) : 1.0);
    const stripColor = isGuest ? 'rgba(255,255,255,0.18)' : ratingToColor(rating);
    const topClass = index === 0 ? "top-1" : index === 1 ? "top-2" : index === 2 ? "top-3" : "";
    const card = document.createElement("div");
    card.className = `player-card ${topClass}`;
    card.style.setProperty("--strip-color", stripColor);
    card.innerHTML = `
      <div class="rating-strip"></div>
      <div class="rank">#${index + 1}</div>
      <div class="name">${p.name}</div>
      <div class="stat wins">${wins}</div>
      <div class="stat played">${played}</div>
      <div class="stat rest">${rest}</div>
      ${isGuest ? '<span class="rating-badge">guest</span>' : `<span class="rating-badge" data-player="${p.name}">${rating.toFixed(1)}</span>`}
      <div class="stat-label lbl-wins">W</div>
      <div class="stat-label lbl-played">P</div>
      <div class="stat-label lbl-rest">R</div>
    `;
    container.appendChild(card);
  });

  setLanguage(currentLang);
}

function workedreport() {
  const container = document.getElementById("reportContainer");
  container.innerHTML = ""; // Clear old cards

  // ⭐ Add title header row
  const header = document.createElement("div");
  header.className = "report-header";
  header.innerHTML = `
    <div class="header-rank" data-i18n="rank">Rank</div>
    <div class="header-name" data-i18n="name">Name</div>
    <div class="header-played" data-i18n="played">Played</div>
    <div class="header-rested" data-i18n="rested">Rested</div>
  `;
  container.appendChild(header);

  // Sort & add players
  const sortedPlayers = [...schedulerState.allPlayers].sort((a, b) => {
    const playedA = schedulerState.PlayedCount.get(a.name) || 0;
    const playedB = schedulerState.PlayedCount.get(b.name) || 0;
    return playedB - playedA;
  });

  sortedPlayers.forEach((p, index) => {
    const played = schedulerState.PlayedCount.get(p.name) || 0;
    const rest = schedulerState.restCount.get(p.name) || 0;
    const isGuest = !!(p.guest || p.unrated) || /\(guest(?:\s+[a-z0-9]+)?\)$/i.test(String(p.name || ''));
    const rating = isGuest ? null : (typeof getRating === 'function' ? (typeof getActiveRating === "function" ? getActiveRating(p.name) : getRating(p.name)) : 1.0);
    const ratingHtml = isGuest
      ? '<span class="rating-badge">guest</span>'
      : `<span class="rating-badge" data-player="${p.name}">${Number.isFinite(rating) ? rating.toFixed(1) : '1.0'}</span>`;

    const card = document.createElement("div");
    const topClass = index === 0 ? "top-1" : index === 1 ? "top-2" : index === 2 ? "top-3" : "";
    card.className = `player-card ${topClass}`;
    card.innerHTML = `
      <div class="rank">#${index + 1}</div>
      <div class="name">${p.name.replace(/^\d+\.?\s*/, "")}</div>
      ${ratingHtml}
      <div class="stat played" style="border-color:${getPlayedColor(played)}">${played}</div>
      <div class="stat rest" style="border-color:${getRestColor(rest)}">${rest}</div>
    `;
    container.appendChild(card);
  });

  // ⭐ Important: Apply translation to new elements
  setLanguage(currentLang);
}


function resetUniqueRoundCycleKeepingSetup(state) {
  // Restart uniqueness, not the session. Round history, results, player
  // counters, fairness queues and the current round position must survive.
  if (!(state.pairPlayedSet instanceof Set)) state.pairPlayedSet = new Set();
  if (!(state.playedTogether instanceof Map)) state.playedTogether = new Map();
  if (!(state.gamesMap instanceof Set)) state.gamesMap = new Set();
  state.pairPlayedSet.clear();
  state.playedTogether.clear();
  state.gamesMap.clear();
  state.pairHistory = new Map();
  state.reachablePairs = new Set();
  state.fixedPairGameQueue = null;
  state.fixedPairGameQueueHash = null;

  // Count the most recently completed round as the first round of the new
  // uniqueness cycle, preventing an immediate identical repeat.
  const latestRoundIndex = allRounds.length - 1;
  const latestRound = allRounds[latestRoundIndex];
  if (latestRound && Array.isArray(latestRound.games)) {
    latestRound.games.forEach(game => {
      if (!game || !Array.isArray(game.pair1) || !Array.isArray(game.pair2)) return;
      const p1 = [...game.pair1].sort().join('&');
      const p2 = [...game.pair2].sort().join('&');
      state.pairPlayedSet.add(p1);
      state.pairPlayedSet.add(p2);
      state.playedTogether.set(p1, latestRoundIndex);
      state.playedTogether.set(p2, latestRoundIndex);
      state.gamesMap.add([p1, p2].sort().join(':'));
    });
  }

  if (typeof showToast === 'function') {
    showToast((typeof t === 'function' && t('uniqueCycleRestarted')) || 'Unique matches completed — starting a new round cycle.');
  }
}

function roundContainsKnownMatch(round, state) {
  if (!round || !Array.isArray(round.games) || !(state.gamesMap instanceof Set)) return false;
  return round.games.some(game => {
    if (!game || !game.pair1 || !game.pair2) return false;
    const p1 = [...game.pair1].sort().join('&');
    const p2 = [...game.pair2].sort().join('&');
    return state.gamesMap.has([p1, p2].sort().join(':'));
  });
}

function checkAndResetPairCycle(schedulerState, games, roundIndex) {
  const {
    activeplayers,
    pairPlayedSet,
    playedTogether,
    gamesMap
  } = schedulerState;

  // --- exhaustion check (INCLUDING latest round) ---
  const bases = activeplayers.map(p => p.split('#')[0]);
  const totalPossiblePairs =
    (bases.length * (bases.length - 1)) / 2;

  let totalPossibleGames = 0;
  for (let a = 0; a < bases.length; a++) {
    for (let b = a + 1; b < bases.length; b++) {
      for (let c = 0; c < bases.length; c++) {
        if (c === a || c === b) continue;
        for (let d = c + 1; d < bases.length; d++) {
          if (d === a || d === b) continue;
          totalPossibleGames++;
        }
      }
    }
  }
  totalPossibleGames = Math.floor(totalPossibleGames / 2);

  const pairsExhausted = pairPlayedSet.size >= totalPossiblePairs;
  const gamesExhausted = totalPossibleGames > 0 && gamesMap.size >= totalPossibleGames;
  if (!pairsExhausted && !gamesExhausted) return false;

  if (schedulerState.uniqueGamesMode) {
    resetUniqueRoundCycleKeepingSetup(schedulerState);
    return true;
  }

  // --- snapshot latest round ---
  const latestPairs = [];
  const latestGames = [];

  for (const game of games) {
    const p1 = game.pair1.slice().sort().join("&");
    const p2 = game.pair2.slice().sort().join("&");

    latestPairs.push(p1, p2);
    latestGames.push([p1, p2].sort().join(":"));
  }

  // --- reset only unique pair/game memory ---
  pairPlayedSet.clear();
  playedTogether.clear();
  gamesMap.clear();

  // --- restore ONLY latest round ---
  for (const key of latestPairs) {
    pairPlayedSet.add(key);
    playedTogether.set(key, roundIndex);
  }

  for (const gk of latestGames) {
    gamesMap.add(gk);
  }

  return true; // cycle reset happened
}

/* ── Per-court dice: re-roll one court using type-aware cascade (MD/LD/XD/Free) ── */
// ═══════════════════════════════════════════════════════════════════
// _rerollCourtGetPairs — SHARED CORE (used by rerollCourt + mbmDice)
// Returns { pair1, pair2 } for a given gameIndex.
// Handles free / singles / MD / LD / XD with 3-source cascade.
// Pure logic — no UI updates.
// ═══════════════════════════════════════════════════════════════════
function _rerollCourtGetPairs(gameIndex, availablePool) {
  const data = allRounds[currentRoundIndex];
  if (!data || !data.games) return null;

  const game = data.games[gameIndex];
  if (!game) return null;

  const fmt       = (schedulerState.courtFormats || [])[gameIndex] || 'doubles';
  const need      = fmt === 'singles' ? 2 : 4;
  const courtType = (schedulerState.courtTypes   || [])[gameIndex] || 'free';

  // ── Convert opponentMap Map→plain object ──
  const oppMapRaw = schedulerState.opponentMap;
  const opponentMapPlain = {};
  if (oppMapRaw instanceof Map) {
    for (const [p, inner] of oppMapRaw) {
      opponentMapPlain[p] = inner instanceof Map ? Object.fromEntries(inner) : (inner || {});
    }
  }

  // ── Gender helpers ──
  function getGender(name) {
    const p = (schedulerState.allPlayers || []).find(pl => pl.name === name);
    return p ? (p.gender || 'Male') : 'Male';
  }
  function genderOk(name, type) {
    if (type === 'MD') return getGender(name) === 'Male';
    if (type === 'LD') return getGender(name) === 'Female';
    return true;
  }

  // ── Pool sources ──
  // availablePool: for MBM = mbmWaitingQueue; for rounds = resting
  const courtPlayers = [...(game.pair1 || []), ...(game.pair2 || [])];
  const resting      = availablePool || (data.resting || []).map(r => r.split('#')[0]);

  let pool;

  if (courtType === 'free' || fmt === 'singles') {
    // Original behaviour: court players + resting
    pool = [...new Set([...courtPlayers, ...resting])];

  } else if (courtType === 'XD') {
    // XD needs exactly 2M + 2F — collect males and females separately via cascade
    const needM = 2, needF = 2;

    function cascadeXD(sourceNames) {
      return {
        males:   sourceNames.filter(p => getGender(p) === 'Male'),
        females: sourceNames.filter(p => getGender(p) === 'Female'),
      };
    }

    // Source 1: current court players
    const src1 = cascadeXD(courtPlayers);
    let males   = [...src1.males];
    let females = [...src1.females];

    // Source 2: Free courts (courts whose type is 'free')
    if (males.length < needM || females.length < needF) {
      const courtTypes = schedulerState.courtTypes || [];
      for (let i = 0; i < (data.games || []).length; i++) {
        if (i === gameIndex) continue;
        const ct = courtTypes[i] || 'free';
        if (ct !== 'free') continue; // only pull from Free courts
        const g = data.games[i];
        if (!g) continue;
        const freePlayers = [...(g.pair1 || []), ...(g.pair2 || [])];
        const fc = cascadeXD(freePlayers);
        males   = [...new Set([...males,   ...fc.males])];
        females = [...new Set([...females, ...fc.females])];
      }
    }

    // Source 3: Resting pool
    if (males.length < needM || females.length < needF) {
      const rc = cascadeXD(resting);
      males   = [...new Set([...males,   ...rc.males])];
      females = [...new Set([...females, ...rc.females])];
    }

    if (males.length < needM || females.length < needF) {
      // Not enough gendered players — fall back to untyped pool
      pool = [...new Set([...courtPlayers, ...resting])];
    } else {
      // Sort each group by play count
      const pc = schedulerState.PlayedCount;
      const byPC = p => (pc instanceof Map ? pc.get(p) || 0 : 0);
      males.sort((a, b) => byPC(a) - byPC(b));
      females.sort((a, b) => byPC(a) - byPC(b));
      // Interleave M-F-M-F so standard pair-finding picks valid XD combos
      pool = [males[0], females[0], males[1], females[1],
              ...males.slice(2), ...females.slice(2)];
      pool = [...new Set(pool)];
    }

  } else {
    // MD or LD: need 4 players of the correct gender via cascade

    // Source 1: gendered players already on this court
    let typed = courtPlayers.filter(p => genderOk(p, courtType));

    // Source 2: gendered players from Free courts (not typed courts)
    if (typed.length < need) {
      const courtTypes = schedulerState.courtTypes || [];
      for (let i = 0; i < (data.games || []).length; i++) {
        if (i === gameIndex) continue;
        const ct = courtTypes[i] || 'free';
        if (ct !== 'free') continue; // only steal from Free courts
        const g = data.games[i];
        if (!g) continue;
        const freePlayers = [...(g.pair1 || []), ...(g.pair2 || [])];
        const eligible = freePlayers.filter(p => genderOk(p, courtType));
        typed = [...new Set([...typed, ...eligible])];
        if (typed.length >= need) break;
      }
    }

    // Source 3: gendered players from resting pool
    if (typed.length < need) {
      const fromRest = resting.filter(p => genderOk(p, courtType));
      typed = [...new Set([...typed, ...fromRest])];
    }

    if (typed.length >= need) {
      pool = typed;
    } else {
      // Not enough typed players — fall back to untyped pool
      pool = [...new Set([...courtPlayers, ...resting])];
    }
  }

  if (pool.length < need) return;

  // Sort by PlayedCount ascending (least played first)
  // Note: XD pool is already interleaved M-F-M-F — sort within the full pool only for non-XD
  const pc = schedulerState.PlayedCount;
  if (courtType !== 'XD') {
    pool.sort((a, b) => ((pc instanceof Map ? pc.get(a) || 0 : 0) - (pc instanceof Map ? pc.get(b) || 0 : 0)));
  }

  let pair1, pair2;

  if (fmt === 'singles') {
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++)
      for (let j = i+1; j < pool.length; j++) {
        const met = (opponentMapPlain[pool[i]] || {})[pool[j]] || 0;
        if (-met > bestScore) { bestScore = -met; pair1 = [pool[i]]; pair2 = [pool[j]]; }
      }
  } else if (courtType === 'XD') {
    // XD: pair1 = [M, F], pair2 = [M, F] — pick best matchup from pool (M-F-M-F interleaved)
    const xdMales   = pool.filter(p => getGender(p) === 'Male');
    const xdFemales = pool.filter(p => getGender(p) === 'Female');
    if (xdMales.length >= 2 && xdFemales.length >= 2) {
      // Temp-mark current court pairs to force different result
      const tempKeys = [];
      for (const pair of [game.pair1, game.pair2]) {
        if (pair && pair.length >= 2) {
          const key = [...pair].sort().join('&');
          if (!schedulerState.pairPlayedSet.has(key)) {
            schedulerState.pairPlayedSet.add(key);
            tempKeys.push(key);
          }
        }
      }
      // Try all M×F combinations for pair1 and pair2
      let bestScore = Infinity;
      for (let mi = 0; mi < xdMales.length; mi++) {
        for (let fi = 0; fi < xdFemales.length; fi++) {
          const p1 = [xdMales[mi], xdFemales[fi]];
          for (let mj = 0; mj < xdMales.length; mj++) {
            if (mj === mi) continue;
            for (let fj = 0; fj < xdFemales.length; fj++) {
              if (fj === fi) continue;
              const p2 = [xdMales[mj], xdFemales[fj]];
              const k1 = p1.slice().sort().join('&');
              const k2 = p2.slice().sort().join('&');
              if (schedulerState.pairPlayedSet.has(k1) || schedulerState.pairPlayedSet.has(k2)) continue;
              // Score = sum of times these players have faced each other
              const oppScore = [p1[0],p1[1]].reduce((s,a) =>
                s + [p2[0],p2[1]].reduce((s2,b) =>
                  s2 + ((opponentMapPlain[a] || {})[b] || 0), 0), 0);
              if (oppScore < bestScore) { bestScore = oppScore; pair1 = p1; pair2 = p2; }
            }
          }
        }
      }
      for (const key of tempKeys) schedulerState.pairPlayedSet.delete(key);
      // Fallback
      if (!pair1) { pair1 = [xdMales[0], xdFemales[0]]; pair2 = [xdMales[1], xdFemales[1]]; }
    } else {
      pair1 = [pool[0], pool[1]]; pair2 = [pool[2], pool[3]];
    }

  } else {
    // MD / LD / Free — standard pair-finding
    const sortedPool = [...pool].sort((a, b) =>
      ((pc instanceof Map ? pc.get(a) || 0 : 0) - (pc instanceof Map ? pc.get(b) || 0 : 0)));
    const minCount = pc instanceof Map ? (pc.get(sortedPool[0]) || 0) : 0;
    const maxCount = pc instanceof Map ? (pc.get(sortedPool[sortedPool.length-1]) || 0) : 0;

    for (let threshold = minCount; threshold <= maxCount; threshold++) {
      const candidate = sortedPool.filter(p => (pc instanceof Map ? pc.get(p) || 0 : 0) <= threshold);
      if (candidate.length < 4) continue;

      // Temp-mark current court pairs as used to force a different result
      const tempKeys = [];
      for (const pair of [game.pair1, game.pair2]) {
        if (pair && pair.length >= 2) {
          const key = [...pair].sort().join('&');
          if (!schedulerState.pairPlayedSet.has(key)) {
            schedulerState.pairPlayedSet.add(key);
            tempKeys.push(key);
          }
        }
      }

      if (typeof findDisjointPairs === 'function' && typeof getMatchupScores === 'function') {
        try {
          const pairs = findDisjointPairs(candidate, schedulerState.pairPlayedSet, 2, opponentMapPlain);
          if (pairs && pairs.length >= 2) {
            const matchups = getMatchupScores(pairs, opponentMapPlain);
            if (matchups && matchups[0]) { pair1 = matchups[0].pair1; pair2 = matchups[0].pair2; }
          }
        } catch(e) {}
      }

      for (const key of tempKeys) schedulerState.pairPlayedSet.delete(key);
      if (pair1) break;
    }
    if (!pair1) { pair1 = [pool[0], pool[1]]; pair2 = [pool[2], pool[3]]; }
  }

  if (!pair1 || !pair2) return null;

  return { pair1, pair2, courtPlayers, resting };
}

// ═══════════════════════════════════════════════════════════════════
// rerollCourt — ROUNDS PAGE wrapper around _rerollCourtGetPairs
// Calls core, updates data.resting/playing, refreshes rounds UI.
// ═══════════════════════════════════════════════════════════════════
async function rerollCourt(gameIndex) {
  const data = allRounds[currentRoundIndex];
  if (!data || !data.games) return;

  const result = _rerollCourtGetPairs(gameIndex, null);
  if (!result) return;

  const { pair1, pair2, courtPlayers, resting } = result;
  const game   = data.games[gameIndex];
  const chosen = new Set([...pair1, ...pair2]);

  const fromThisCourt          = new Set(courtPlayers);
  const fromResting            = new Set(resting);
  const pulledFromOtherCourts  = [...chosen].filter(p => !fromThisCourt.has(p) && !fromResting.has(p));
  const displacedFromThisCourt = courtPlayers.filter(p => !chosen.has(p));
  const pulledFromResting      = [...chosen].filter(p => fromResting.has(p));

  // ── Update the target court ──
  data.games[gameIndex] = { ...game, pair1, pair2 };

  // ── Fix free courts that lost players (Source 2 pull) ──
  if (pulledFromOtherCourts.length > 0) {
    const courtTypes = schedulerState.courtTypes || [];
    let swapPool = [...displacedFromThisCourt];

    for (let i = 0; i < (data.games || []).length; i++) {
      if (i === gameIndex) continue;
      const ct = courtTypes[i] || 'free';
      if (ct !== 'free') continue;
      const g = data.games[i];
      if (!g) continue;

      const allOnCourt    = [...(g.pair1 || []), ...(g.pair2 || [])];
      const takenFromHere = allOnCourt.filter(p => pulledFromOtherCourts.includes(p));
      if (takenFromHere.length === 0) continue;

      let updatedCourt = allOnCourt.filter(p => !takenFromHere.includes(p));
      const toInsert   = swapPool.splice(0, takenFromHere.length);
      updatedCourt     = [...updatedCourt, ...toInsert];

      const unplaced = takenFromHere.slice(toInsert.length);
      data.resting   = [...(data.resting || []), ...unplaced];

      const origSize1 = (g.pair1 || []).length;
      data.games[i]   = { ...g,
        pair1: updatedCourt.slice(0, origSize1),
        pair2: updatedCourt.slice(origSize1, origSize1 * 2)
      };
    }
    if (swapPool.length > 0) data.resting = [...(data.resting || []), ...swapPool];
  } else {
    data.resting = [
      ...(data.resting || []).filter(r => !chosen.has(r.split('#')[0])),
      ...displacedFromThisCourt
    ];
  }

  data.resting = (data.resting || []).filter(r => !chosen.has(r.split('#')[0]));
  data.playing = [
    ...(data.playing || []).filter(p => !displacedFromThisCourt.includes(p.split('#')[0])),
    ...pulledFromResting
  ];

  showRound(currentRoundIndex);
  if (typeof saveSnapshot === 'function') saveSnapshot();
}
