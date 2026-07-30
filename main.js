// Build 394: skip the extra Google/LINE handoff pages and open authentication directly.

// Build 393: show today's playable organiser slot without the removed organiser-login gate.
// Initialise welcome state before any carousel code can run. This keeps the
// hub refresh usable even if a later, unrelated startup component fails.
window.__scsWelcomeHubData = window.__scsWelcomeHubData || {
  player: null,
  organiser: null,
  vault: null,
  refreshedAt: 0
};
window.__scsWelcomeHubRefreshPromise = null;
window.__scsWelcomeHubRefreshGeneration = 0;

window.__scsStartupBeganAt = performance.now();
window.scsFinishStartup = function scsFinishStartup() {
  var splash = document.getElementById('scsStartupSplash');
  if (!splash || splash.classList.contains('is-ready')) return;
  var elapsed = performance.now() - (window.__scsStartupBeganAt || 0);
  var delay = Math.max(0, 650 - elapsed);
  window.setTimeout(function() {
    requestAnimationFrame(function() {
      splash.classList.add('is-ready');
      window.setTimeout(function() { if (splash && splash.parentNode) splash.remove(); }, 360);
    });
  }, delay);
};
window.setTimeout(function() {
  if (typeof window.scsFinishStartup === 'function') window.scsFinishStartup();
}, 7000);

// Build 392: preload every workspace while the startup ring is visible.
// Mode changes can then render from the prepared in-memory/local cache and
// perform only a quiet freshness sync instead of starting a first-time load.
window.__scsWorkspacePrefetchReady = false;
window.__scsWorkspacePrefetchPromise = null;
window.scsPrefetchAllWorkspaceData = function scsPrefetchAllWorkspaceData() {
  if (window.__scsWorkspacePrefetchPromise) return window.__scsWorkspacePrefetchPromise;

  var jobs = [];
  function addJob(name, fn) {
    if (typeof fn !== 'function') return;
    jobs.push(Promise.resolve().then(fn).catch(function(error) {
      console.warn('Startup prefetch skipped (' + name + '):', error && (error.message || error));
      return null;
    }));
  }

  // Shared account, membership and player data used across all workspaces.
  addJob('local player sync', function() {
    return typeof syncToLocal === 'function' ? syncToLocal() : null;
  });
  addJob('global player cache', function() {
    return typeof syncGlobalPlayersCache === 'function' ? syncGlobalPlayersCache() : null;
  });
  addJob('organiser clubs', function() {
    return typeof getOrganiserEligibleClubs === 'function' ? getOrganiserEligibleClubs() : null;
  });

  // Player and Club Manager calendar/slot data. Their loaders populate the
  // same in-memory maps later used by their workspace renderers.
  addJob('player slots', function() {
    return typeof _mcsLoadMonthSlots === 'function' ? _mcsLoadMonthSlots() : null;
  });
  addJob('club manager slots', function() {
    return typeof _vhsLoadMonthSlots === 'function' ? _vhsLoadMonthSlots() : null;
  });

  // Welcome/dashboard counters and role labels use these shared refreshes.
  addJob('welcome roles', function() {
    return typeof restoreUserClubRoles === 'function' ? restoreUserClubRoles() : null;
  });
  addJob('launcher session', function() {
    return typeof renderLauncherStartSessionCard === 'function' ? renderLauncherStartSessionCard() : null;
  });

  window.__scsWorkspacePrefetchPromise = Promise.allSettled(jobs).then(async function() {
    // The mode-selection page is rendered only from this completed startup cache.
    // Run it after role restoration and slot prefetch so every label/count/photo
    // uses the same resolved club context as the actual workspace pages.
    if (typeof window.scsPrefetchWelcomeHubData === 'function') {
      await window.scsPrefetchWelcomeHubData();
    }
    window.__scsWorkspacePrefetchReady = true;
    window.dispatchEvent(new CustomEvent('scs:workspace-prefetch-ready'));
    return true;
  });
  return window.__scsWorkspacePrefetchPromise;
};


/* ══════════════════════════════════════════════
   MODE SYSTEM -- Viewer / Organiser
   Stored in sessionStorage (resets on app close)
══════════════════════════════════════════════ */

var appMode = null; // 'viewer' | 'organiser'

/* Cross-device Organiser/Vault grants. Stores verified roles, never passwords. */
async function getLinkedManagementClub(role) {
  var user = (typeof authGetUser === 'function') ? authGetUser() : null;
  if (!user || !user.id || !['organiser', 'vault'].includes(role)) return null;
  var verifiedColumn = role === 'organiser' ? 'organiser_verified' : 'vault_verified';
  var active = await sbGet('user_club_roles',
    'user_account_id=eq.' + user.id +
    '&' + verifiedColumn + '=eq.true' +
    '&order=updated_at.desc&select=club_id')
    .catch(function() { return []; });
  if (!active || !active.length) return null;
  var clubs = await sbGet('clubs', 'id=eq.' + active[0].club_id + '&select=id,name')
    .catch(function() { return []; });
  return clubs && clubs[0] ? clubs[0] : null;
}

async function saveUserClubRole(clubId, role) {
  var user = (typeof authGetUser === 'function') ? authGetUser() : null;
  if (!user || !user.id || !clubId || !['organiser', 'vault'].includes(role)) return;

  // Organiser and Club Manager are independent workspaces. Restrict only a
  // duplicate grant for the same role; never compare one role with the other.
  var verifiedColumn = role === 'organiser' ? 'organiser_verified' : 'vault_verified';
  var active = await sbGet('user_club_roles',
    'user_account_id=eq.' + user.id +
    '&' + verifiedColumn + '=eq.true' +
    '&order=updated_at.desc&select=club_id')
    .catch(function() { return []; });
  var linked = (active || []).find(function(g) { return String(g.club_id) !== String(clubId); });
  if (linked) {
    // Move this role to the newly selected club while preserving any other
    // workspace grant stored on the old row.
    var oldRows = await sbGet('user_club_roles',
      'user_account_id=eq.' + user.id + '&club_id=eq.' + linked.club_id +
      '&select=organiser_verified,vault_verified').catch(function() { return []; });
    var old = oldRows && oldRows[0] ? oldRows[0] : {};
    await sbUpsert('user_club_roles', {
      user_account_id: user.id,
      club_id: linked.club_id,
      organiser_verified: role === 'organiser' ? false : !!old.organiser_verified,
      vault_verified: role === 'vault' ? false : !!old.vault_verified,
      updated_at: new Date().toISOString()
    }, 'user_account_id,club_id');
  }

  var rows = await sbGet('user_club_roles',
    'user_account_id=eq.' + user.id + '&club_id=eq.' + clubId +
    '&select=organiser_verified,vault_verified').catch(function() { return []; });
  var current = rows && rows[0] ? rows[0] : {};
  var data = {
    user_account_id: user.id,
    club_id: clubId,
    organiser_verified: role === 'organiser' ? true : !!current.organiser_verified,
    vault_verified: role === 'vault' ? true : !!current.vault_verified,
    updated_at: new Date().toISOString()
  };
  await sbUpsert('user_club_roles', data, 'user_account_id,club_id');
}

/* Explicit role logout must also disable cross-device auto-login. */
async function revokeUserClubRole(clubId, role) {
  var user = (typeof authGetUser === 'function') ? authGetUser() : null;
  if (!user || !user.id || !clubId || !['organiser', 'vault'].includes(role)) return;
  var rows = await sbGet('user_club_roles',
    'user_account_id=eq.' + user.id + '&club_id=eq.' + clubId +
    '&select=organiser_verified,vault_verified').catch(function() { return []; });
  var current = rows && rows[0] ? rows[0] : {};
  await sbUpsert('user_club_roles', {
    user_account_id: user.id,
    club_id: clubId,
    organiser_verified: role === 'organiser' ? false : !!current.organiser_verified,
    vault_verified: role === 'vault' ? false : !!current.vault_verified,
    updated_at: new Date().toISOString()
  }, 'user_account_id,club_id');
}

function hasVerifiedWorkspaceRole(role) {
  var isOrganiser = role === 'organiser';
  var verifiedKey = isOrganiser ? 'scs_organiser_verified' : 'scs_vault_verified';
  var clubKey = isOrganiser ? 'kbrr_org_club_id' : 'kbrr_vault_club_id';
  var verified = sessionStorage.getItem(verifiedKey) === '1' ||
    localStorage.getItem(verifiedKey) === '1';
  var clubId = localStorage.getItem(clubKey) || '';
  if (verified && clubId) return true;

  if (verified && !clubId) {
    sessionStorage.removeItem(verifiedKey);
    localStorage.removeItem(verifiedKey);
  }
  return false;
}

/* Organiser access follows club membership. No organiser password is stored or
   requested. Club Manager access is independent. */
async function getOrganiserEligibleClubs(userOverride) {
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    var demoClub = (typeof getMyClub === 'function') ? getMyClub() : null;
    return demoClub && demoClub.id ? [{ id: demoClub.id, name: demoClub.name || '', source: 'demo' }] : [];
  }
  var user = userOverride || ((typeof authGetUser === 'function') ? authGetUser() : null);
  if (!user || !user.id) return [];

  var cachedId = localStorage.getItem('kbrr_org_club_id') || '';
  var cachedName = localStorage.getItem('kbrr_org_club_name') || '';
  var memberships;
  try {
    memberships = await sbGet('memberships',
      'user_account_id=eq.' + encodeURIComponent(user.id) + '&select=club_id');
  } catch (error) {
    return cachedId ? [{ id: cachedId, name: cachedName, source: 'cache' }] : [];
  }

  var ids = Array.from(new Set((memberships || []).map(function(membership) {
    return String(membership.club_id || '');
  }).filter(Boolean)));
  var clubs = ids.length
    ? await sbGet('clubs', 'id=in.(' + ids.map(encodeURIComponent).join(',') + ')&select=id,name&order=name.asc')
        .catch(function() { return []; })
    : [];
  var options = (clubs || []).map(function(club) {
    return { id: String(club.id), name: club.name || '', source: 'membership' };
  });

  var vaultVerified = sessionStorage.getItem('scs_vault_verified') === '1' ||
    localStorage.getItem('scs_vault_verified') === '1';
  var vaultClubId = localStorage.getItem('kbrr_vault_club_id') || '';
  if (vaultVerified && vaultClubId && !options.some(function(club) { return club.id === String(vaultClubId); })) {
    options.unshift({
      id: String(vaultClubId),
      name: localStorage.getItem('kbrr_vault_club_name') || '',
      source: 'vault'
    });
  }
  return options;
}

async function syncOrganiserMembershipAccess(userOverride, selectedClubId) {
  var options = await getOrganiserEligibleClubs(userOverride);
  if (!options.length) {
    sessionStorage.removeItem('scs_organiser_verified');
    localStorage.removeItem('scs_organiser_verified');
    localStorage.removeItem('kbrr_org_club_id');
    localStorage.removeItem('kbrr_org_club_name');
    return null;
  }
  var cachedId = localStorage.getItem('kbrr_org_club_id') || '';
  var activeClub = (typeof getMyClub === 'function') ? getMyClub() : null;
  var preferredId = selectedClubId || (activeClub && activeClub.id) || cachedId;
  var club = options.find(function(option) { return option.id === String(preferredId || ''); }) || options[0];
  sessionStorage.setItem('scs_organiser_verified', '1');
  localStorage.setItem('scs_organiser_verified', '1');
  localStorage.setItem('kbrr_org_club_id', club.id);
  localStorage.setItem('kbrr_org_club_name', club.name || '');
  return club;
}

async function restoreUserClubRoles(userOverride) {
  var user = userOverride || ((typeof authGetUser === 'function') ? authGetUser() : null);
  if (!user || !user.id) return;

  var grants = await sbGet('user_club_roles',
    'user_account_id=eq.' + user.id +
    '&order=updated_at.desc&select=club_id,organiser_verified,vault_verified,updated_at')
    .catch(function() { return null; });
  if (grants === null) return; // Offline/server error: preserve last known local access.

  // Restore each workspace independently. The newest active grant for each
  // role wins, and the two roles may point to different clubs.
  var orgGrant = grants.find(function(g) { return g.organiser_verified; }) || null;
  var vaultGrant = grants.find(function(g) { return g.vault_verified; }) || null;
  var ids = [];
  if (orgGrant) ids.push(orgGrant.club_id);
  if (vaultGrant && !ids.includes(vaultGrant.club_id)) ids.push(vaultGrant.club_id);
  var clubs = ids.length
    ? await sbGet('clubs', 'id=in.(' + ids.join(',') + ')&select=id,name').catch(function() { return null; })
    : [];
  if (clubs === null) return;

  ['scs_organiser_verified', 'scs_vault_verified'].forEach(function(key) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  });
  ['kbrr_org_club_id', 'kbrr_org_club_name', 'kbrr_vault_club_id', 'kbrr_vault_club_name']
    .forEach(function(key) { localStorage.removeItem(key); });

  var names = {};
  (clubs || []).forEach(function(c) { names[c.id] = c.name || ''; });
  if (orgGrant && !Object.prototype.hasOwnProperty.call(names, orgGrant.club_id)) orgGrant = null;
  if (vaultGrant && !Object.prototype.hasOwnProperty.call(names, vaultGrant.club_id)) vaultGrant = null;

  if (orgGrant) {
    localStorage.setItem('scs_organiser_verified', '1');
    sessionStorage.setItem('scs_organiser_verified', '1');
    localStorage.setItem('kbrr_org_club_id', orgGrant.club_id);
    localStorage.setItem('kbrr_org_club_name', names[orgGrant.club_id] || '');
  }
  if (vaultGrant) {
    localStorage.setItem('scs_vault_verified', '1');
    sessionStorage.setItem('scs_vault_verified', '1');
    localStorage.setItem('kbrr_vault_club_id', vaultGrant.club_id);
    localStorage.setItem('kbrr_vault_club_name', names[vaultGrant.club_id] || '');
  }

  // Membership-based Organiser access remains independent of Club Manager.
  await syncOrganiserMembershipAccess(user, orgGrant ? orgGrant.club_id : '');
}

function getExperienceMode() {
  var saved = localStorage.getItem('scs_experience_mode');
  return ['standard', 'intermediate', 'advanced'].includes(saved) ? saved : 'advanced';
}

function experienceAllowsRole(role) {
  var level = getExperienceMode();
  if (role === 'viewer') return true;
  if (role === 'organiser') return level === 'intermediate' || level === 'advanced';
  if (role === 'vault') return level === 'advanced';
  return false;
}

function syncExperienceModeUI() {
  var level = getExperienceMode();
  document.body.classList.toggle('experience-standard', level === 'standard');
  document.body.classList.toggle('experience-intermediate', level === 'intermediate');
  document.body.classList.toggle('experience-advanced', level === 'advanced');
  var organiser = document.getElementById('experienceModeOrganiser');
  var vault = document.getElementById('experienceModeVault');
  var section = document.getElementById('experienceOrganiserSection');
  if (organiser) organiser.style.display = level === 'standard' ? 'none' : '';
  if (vault) vault.style.display = level === 'advanced' ? '' : 'none';
  if (section) section.style.display = level === 'standard' ? 'none' : '';

  ['standard', 'intermediate', 'advanced'].forEach(function(name) {
    document.getElementById('experience_' + name)?.classList.toggle('active', name === level);
    var launcherButton = document.getElementById('mlExperience' + name.charAt(0).toUpperCase() + name.slice(1));
    if (launcherButton) launcherButton.classList.toggle('active', name === level);
  });
  var track = document.getElementById('mlExperienceTrack');
  if (track) track.setAttribute('data-level', level);
  var caption = document.getElementById('mlExperienceCaption');
  if (caption) caption.textContent = level === 'standard'
    ? t('playerWorkspace')
    : (level === 'intermediate' ? t('playerOrganiserWorkspaces') : t('allClubWorkspaces'));
  var description = document.getElementById('experienceModeDescription');
  if (description) description.textContent = level === 'standard'
    ? t('playerWorkspace')
    : (level === 'intermediate' ? t('playerOrganiserDescription') : t('allWorkspaceDescription'));
  var clubManagerTitle = document.querySelector('#experienceModeVault .ml-mode-name');
  if (clubManagerTitle) clubManagerTitle.textContent = t('clubManagerRole');
  if (typeof welcomeSelectWorkspace === 'function') welcomeSelectWorkspace(welcomeSelectedWorkspace || appMode || 'viewer');
}

function setExperienceMode(level) {
  if (!['standard', 'intermediate', 'advanced'].includes(level)) return;
  localStorage.setItem('scs_experience_mode', level);
  syncExperienceModeUI();
  // Changing the experience selector must never enter a hub. If the previous
  // role is no longer available, quietly make Viewer the next saved role while
  // leaving the user on the mode launcher or Settings page.
  if (appMode && !experienceAllowsRole(appMode)) {
    appMode = 'viewer';
    sessionStorage.setItem('appMode', 'viewer');
    localStorage.setItem('kbrr_app_mode', 'viewer');
    applyMode('viewer');
    updateModePill('viewer');
  }
  if (typeof showToast === 'function') showToast('Experience mode: ' + level.charAt(0).toUpperCase() + level.slice(1));
}


/* Build 214 — welcome-style workspace selector. */
var welcomeSelectedWorkspace = 'viewer';

function updateWelcomeWorkspaceClubNames() {
  var organiserVerified = hasVerifiedWorkspaceRole('organiser');
  var vaultVerified = hasVerifiedWorkspaceRole('vault');
  var accountUser = (typeof authGetUser === 'function') ? authGetUser() : null;
  var player = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
  var playerName = (accountUser && (accountUser.nickname || accountUser.displayName)) ||
    (player && (player.displayName || player.name || player.nickname)) || '';
  var names = {
    organiser: organiserVerified
      ? (localStorage.getItem('kbrr_org_club_name') || '')
      : '',
    vault: vaultVerified
      ? (localStorage.getItem('kbrr_vault_club_name') || '')
      : ''
  };
  var playerEl = document.getElementById('welcomePlayerName');
  if (playerEl) {
    playerEl.textContent = playerName;
    playerEl.hidden = !playerName;
    playerEl.classList.remove('is-login-prompt');
  }
  var loginLabel = (typeof t === 'function' && t('login')) || 'Login';
  [
    ['welcomeOrganiserClubName', names.organiser, organiserVerified],
    ['welcomeVaultClubName', names.vault, vaultVerified]
  ].forEach(function(item) {
    var el = document.getElementById(item[0]);
    if (!el) return;
    var text = item[2] ? item[1] : loginLabel;
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('is-login-prompt', !item[2]);
  });
  var playerLogout = document.getElementById('welcomePlayerLogout');
  var organiserLogout = document.getElementById('welcomeOrganiserLogout');
  var vaultLogout = document.getElementById('welcomeVaultLogout');
  if (playerLogout) playerLogout.hidden = !playerName;
  if (organiserLogout) organiserLogout.hidden = !organiserVerified;
  if (vaultLogout) vaultLogout.hidden = !vaultVerified;
}

async function welcomeManualRefresh() {
  var btn = document.querySelector('.welcome-refresh-btn');
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add('is-refreshing'); }
  try {
    if (typeof restoreUserClubRoles === 'function' && typeof authGetUser === 'function') {
      await restoreUserClubRoles(authGetUser());
    }
    if (typeof syncToLocal === 'function') await syncToLocal();
    if (typeof window.scsPrefetchWelcomeHubData === 'function') {
      await window.scsPrefetchWelcomeHubData();
    }
    updateWelcomeWorkspaceClubNames();
    if (typeof mlSyncLangDisplay === 'function') mlSyncLangDisplay();
    if (typeof showToast === 'function') showToast('Welcome refreshed');
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Refresh failed');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-refreshing'); }
  }
}

function welcomeLogoutWorkspace(role) {
  if (role === 'viewer') {
    // Player logout is the full application logout. Reuse the existing
    // authenticated app logout flow so the user returns to the Login screen.
    if (typeof authDoLogout === 'function') {
      authDoLogout();
      return;
    }
    if (typeof authLogout === 'function') authLogout();
    localStorage.removeItem('auth_user');
    localStorage.removeItem('kbrr_my_player');
    welcomeSelectedWorkspace = 'viewer';
    if (typeof authShowScreen === 'function') authShowScreen('login');
    return;
  }
  if (role === 'organiser' && typeof organiserLogoutClub === 'function') organiserLogoutClub();
  if (role === 'vault' && typeof vaultLogoutClub === 'function') vaultLogoutClub();
  setTimeout(updateWelcomeWorkspaceClubNames, 0);
}

function welcomeSelectWorkspace(mode) {
  if (!['viewer', 'organiser', 'vault'].includes(mode)) return;
  if (mode === 'vault' && typeof isDemoMode === 'function' && isDemoMode()) {
    if (typeof showDemoVaultBlock === 'function') showDemoVaultBlock();
    return;
  }
  welcomeSelectedWorkspace = mode;
  var carousel = document.getElementById('welcomeWorkspaceCarousel');
  if (carousel) carousel.setAttribute('data-selected', mode);

  // Build 388: each workspace keeps its permanent location.
  // Selection changes only the tile emphasis; it no longer rotates the
  // chosen workspace into the centre position.
  var visibleOrder = ['viewer', 'organiser', 'vault'];
  ['viewer', 'organiser', 'vault'].forEach(function(name) {
    var el = document.getElementById('experienceMode' + (name === 'viewer' ? 'Viewer' : name === 'organiser' ? 'Organiser' : 'Vault'));
    if (!el) return;
    var selected = name === mode;
    var position = visibleOrder.indexOf(name);
    el.classList.toggle('active', selected);
    // Do not assign carousel position classes. The old carousel-centre class
    // makes the Organiser tile project forward even when Player is selected.
    el.classList.remove('carousel-left', 'carousel-centre', 'carousel-right');
    el.style.order = String(position + 1);
    el.setAttribute('aria-checked', selected ? 'true' : 'false');
    el.setAttribute('tabindex', selected ? '0' : '-1');
  });
  document.querySelectorAll('.welcome-carousel-dot').forEach(function(dot, index) {
    var dotMode = ['viewer', 'organiser', 'vault'][index];
    var selected = dotMode === mode;
    dot.classList.toggle('active', selected);
    dot.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  var caption = document.getElementById('mlExperienceCaption');
  if (caption) caption.textContent = mode === 'viewer'
    ? 'Player workspace'
    : (mode === 'organiser' ? 'Session Organiser workspace' : 'Club Manager workspace');
  var nextAction1 = document.getElementById('welcomeNextAction1');
  var nextAction2 = document.getElementById('welcomeNextAction2');
  var nextActionKeys = mode === 'organiser'
    ? ['organiserCardAction1', 'organiserCardAction2']
    : (mode === 'vault'
      ? ['managerCardAction1', 'managerCardAction2']
      : ['playerCardAction1', 'playerCardAction2']);
  if (nextAction1) {
    nextAction1.setAttribute('data-i18n', nextActionKeys[0]);
    nextAction1.textContent = typeof t === 'function' ? t(nextActionKeys[0]) : nextAction1.textContent;
  }
  if (nextAction2) {
    nextAction2.setAttribute('data-i18n', nextActionKeys[1]);
    nextAction2.textContent = typeof t === 'function' ? t(nextActionKeys[1]) : nextAction2.textContent;
  }
  updateWelcomeWorkspaceClubNames();
  updateWelcomeHubCard(mode);
}

function updateWelcomeHubHelper(mode) {
  var helper = document.getElementById('welcomeNextAction1');
  if (!helper) return;
  helper.removeAttribute('data-i18n');
  helper.textContent = mode === 'viewer'
    ? 'Find and join slots, play and improve.'
    : (mode === 'organiser'
      ? 'Create, manage and run your next session efficiently.'
      : 'Manage clubs, members, organisers and activities.');
}

function updateWelcomeHubCard(mode) {
  var heading = document.getElementById('welcomeHubHeading');
  var continueLabel = document.getElementById('welcomeContinueLabel');
  if (heading) heading.textContent = 'Choose your hub';
  if (continueLabel) continueLabel.textContent = mode === 'viewer' ? 'Enter My Hub' : (mode === 'organiser' ? 'Enter Session Hub' : 'Enter Club Hub');
  updateWelcomeHubHelper(mode);
  if (mode !== 'viewer') return;

  var player = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
  var account = (typeof authGetUser === 'function') ? authGetUser() : null;
  var name = (account && (account.nickname || account.displayName)) || (player && player.name) || 'Player';
  var photo = document.getElementById('welcomePlayerPhoto');
  var nameEl = document.getElementById('welcomePlayerName');
  var ratingEl = document.getElementById('welcomePlayerRating');
  var pointsEl = document.getElementById('welcomePlayerPoints');
  if (photo) {
    var savedPhoto = welcomeGetSavedRolePhoto('viewer');
    photo.src = savedPhoto || (player && player.gender === 'Female' ? 'female.png' : 'male.png');
  }
  if (nameEl) nameEl.textContent = name;
  var rating = Number(player && (player.global_rating ?? player.rating));
  var points = Number(player && (player.global_points ?? player.points));
  if (ratingEl) ratingEl.textContent = Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : '1.0';
  if (pointsEl) pointsEl.textContent = Number.isFinite(points) ? points.toFixed(1) : '0.0';
}

/* Build 456: the Round hub has one actionable upcoming-slot tile. It opens
   Organiser normally, then brings the existing time-gated Start Session card
   into view. The existing slot flow remains the authority for starting. */
async function welcomeOpenOrganiserUpcomingSlot(event) {
  if (event) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  }
  var organiser = (window.__scsWelcomeHubData && window.__scsWelcomeHubData.organiser) || {};
  var slot = organiser.nextSlot || null;
  var tile = document.getElementById('welcomeOrganiserNextSlot');
  if (!slot || !slot.id || (tile && tile.getAttribute('aria-disabled') === 'true')) return;
  if (tile && tile.classList.contains('is-opening')) return;

  if (typeof authIsLoggedIn === 'function' && !authIsLoggedIn()) {
    sessionStorage.setItem('scs_pending_workspace', 'organiser');
    if (typeof authShowScreen === 'function') authShowScreen('login');
    return;
  }
  if (typeof canAccessMode === 'function' && !canAccessMode('organiser')) {
    if (typeof showModeUpgradePrompt === 'function') showModeUpgradePrompt('organiser');
    return;
  }

  if (tile) tile.classList.add('is-opening');
  try {
    var club = await syncOrganiserMembershipAccess(null, organiser.clubId || '');
    if (!club || !club.id) return;
    if (typeof setMyClub === 'function') setMyClub(club.id, club.name || organiser.clubName || '');
    localStorage.setItem('kbrr_club_mode', club.source === 'vault' ? 'admin' : 'user');
    appMode = 'organiser';
    sessionStorage.setItem('appMode', 'organiser');
    localStorage.setItem('kbrr_app_mode', 'organiser');
    applyMode('organiser');
    updateModePill('organiser');
    var overlay = document.getElementById('modeSelectOverlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof homeHideScreen === 'function') homeHideScreen();
    if (typeof vaultSlotsStartRoundsFromSlot === 'function') {
      await vaultSlotsStartRoundsFromSlot(slot.id);
    }
    var roundsPage = document.getElementById('roundsPage');
    var roundOpened = roundsPage && roundsPage.style.display !== 'none';
    var rollingOpened = typeof schedulerState !== 'undefined' && schedulerState.mbmActive;
    if (!roundOpened && !rollingOpened && overlay) overlay.style.display = 'flex';
  } finally {
    if (tile) tile.classList.remove('is-opening');
  }
}


/* Build 422: My Hub profile photo — camera, photo library, remove, local persistence. */
function welcomeProfilePhotoStorageKey() {
  var account = (typeof authGetUser === 'function') ? authGetUser() : null;
  var player = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
  var identity = (account && (account.id || account.user_id || account.email || account.nickname)) ||
                 (player && (player.id || player.user_id || player.email || player.name)) || 'default';
  return 'scs_welcome_profile_photo_' + String(identity).toLowerCase().replace(/[^a-z0-9_.@-]/g, '_');
}

function welcomeGetSavedProfilePhoto() {
  try { return localStorage.getItem(welcomeProfilePhotoStorageKey()) || ''; }
  catch (e) { return ''; }
}

function welcomeOpenPhotoMenu() {
  var sheet = document.getElementById('welcomePhotoSheet');
  if (!sheet) return;
  sheet.hidden = false;
  requestAnimationFrame(function(){ sheet.classList.add('open'); });
  document.body.classList.add('welcome-photo-menu-open');
}

function welcomeClosePhotoMenu() {
  var sheet = document.getElementById('welcomePhotoSheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  document.body.classList.remove('welcome-photo-menu-open');
  setTimeout(function(){ if (!sheet.classList.contains('open')) sheet.hidden = true; }, 180);
}

function welcomeChooseProfilePhoto(source) {
  var input = document.getElementById(source === 'camera' ? 'welcomeProfileCameraInput' : 'welcomeProfileLibraryInput');
  welcomeClosePhotoMenu();
  if (!input) return;
  input.value = '';
  setTimeout(function(){ input.click(); }, 80);
}

function welcomeHandleProfilePhoto(input) {
  var file = input && input.files && input.files[0];
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) {
    alert('Please select an image.');
    return;
  }
  var reader = new FileReader();
  reader.onerror = function(){ alert('Unable to read this photo. Please try another image.'); };
  reader.onload = function(event) {
    var image = new Image();
    image.onerror = function(){ alert('Unable to open this photo. Please try another image.'); };
    image.onload = function() {
      try {
        var side = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
        var sx = Math.max(0, ((image.naturalWidth || image.width) - side) / 2);
        var sy = Math.max(0, ((image.naturalHeight || image.height) - side) / 2);
        var canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(image, sx, sy, side, side, 0, 0, 512, 512);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        localStorage.setItem(welcomeProfilePhotoStorageKey(), dataUrl);
        var photo = document.getElementById('welcomePlayerPhoto');
        if (photo) photo.src = dataUrl;
      } catch (e) {
        alert('The photo could not be saved. Please try a smaller image.');
      }
    };
    image.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function welcomeRemoveProfilePhoto() {
  try { localStorage.removeItem(welcomeProfilePhotoStorageKey()); } catch (e) {}
  var player = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
  var photo = document.getElementById('welcomePlayerPhoto');
  if (photo) photo.src = player && player.gender === 'Female' ? 'female.png' : 'male.png';
  welcomeClosePhotoMenu();
}


var welcomeTileSliding = false;
function welcomeCycleWorkspace(direction) {
  if (welcomeTileSliding) return;
  var modes = ['viewer', 'organiser', 'vault'];
  var current = modes.indexOf(welcomeSelectedWorkspace);
  if (current < 0) current = 0;
  var step = direction < 0 ? -1 : 1;
  var next = (current + step + modes.length) % modes.length;
  var outgoing = document.getElementById('experienceMode' + (modes[current] === 'viewer' ? 'Viewer' : modes[current] === 'organiser' ? 'Organiser' : 'Vault'));
  var incoming = document.getElementById('experienceMode' + (next === 0 ? 'Viewer' : next === 1 ? 'Organiser' : 'Vault'));
  if (!outgoing || !incoming || outgoing === incoming) { welcomeSelectWorkspace(modes[next]); return; }

  welcomeTileSliding = true;
  var fromClass = step > 0 ? 'scs-slide-from-right' : 'scs-slide-from-left';
  var toClass = step > 0 ? 'scs-slide-to-left' : 'scs-slide-to-right';
  incoming.classList.add('scs-slide-visible', fromClass);
  outgoing.classList.add('scs-slide-visible');
  void incoming.offsetWidth;
  incoming.classList.add('scs-slide-animate');
  outgoing.classList.add('scs-slide-animate');
  requestAnimationFrame(function(){
    incoming.classList.remove(fromClass);
    outgoing.classList.add(toClass);
  });
  setTimeout(function(){
    outgoing.classList.remove('scs-slide-visible','scs-slide-animate','scs-slide-to-left','scs-slide-to-right');
    incoming.classList.remove('scs-slide-visible','scs-slide-animate','scs-slide-from-left','scs-slide-from-right');
    welcomeSelectWorkspace(modes[next]);
    welcomeTileSliding = false;
  }, 390);
}

(function enableWelcomeWorkspaceSwipe() {
  var startX = null;
  var startY = null;
  document.addEventListener('touchstart', function(event) {
    var carousel = event.target && event.target.closest ? event.target.closest('#welcomeWorkspaceCarousel') : null;
    if (!carousel || !event.touches || event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', function(event) {
    if (startX === null || !event.changedTouches || !event.changedTouches.length) return;
    var dx = event.changedTouches[0].clientX - startX;
    var dy = event.changedTouches[0].clientY - startY;
    startX = null;
    startY = null;
    if (Math.abs(dx) < 45 || Math.abs(dx) <= Math.abs(dy)) return;
    welcomeCycleWorkspace(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

async function welcomeContinueWorkspace() {
  var targetMode = welcomeSelectedWorkspace || 'viewer';

  // Player can be opened without an account. Organiser and Club Manager are
  // protected workspaces and must always show the account login first when the
  // user is not signed in.
  if (targetMode !== 'viewer' &&
      typeof authIsLoggedIn === 'function' &&
      !authIsLoggedIn()) {
    sessionStorage.setItem('scs_pending_workspace', targetMode);
    if (typeof authShowScreen === 'function') authShowScreen('login');
    return;
  }

  // Re-validate the persisted account before opening a protected workspace.
  if (targetMode !== 'viewer' && typeof authIsLoggedIn === 'function' && authIsLoggedIn()) {
    if (typeof authVerifySession === 'function') {
      var validSession = await authVerifySession();
      if (!validSession) return;
    }
    if (typeof _startSessionWatch === 'function') _startSessionWatch();
  }
  switchMode(targetMode);
}

function selectMode(mode) {
  appMode = mode;
  sessionStorage.setItem('appMode', mode);
  localStorage.setItem('kbrr_app_mode', mode);
  // Hide mode select overlay
  var overlay = document.getElementById('modeSelectOverlay');
  // Welcome is already visible from the initial HTML. Never hide it during
  // startup checks; this prevents any Player/Organiser page from flashing.
  if (overlay) overlay.style.display = 'flex';
  // Apply viewer/organiser body classes
  applyMode(mode);
  // Show home screen (defined in HomeScreen.js)
  showHomeScreen();
}

function applyMode(mode) {
  appMode = mode;

  // Body class for organiser scrollable tabs (kept for any CSS that uses it)
  document.body.classList.toggle('organiser-tabs', mode === 'organiser');
  document.body.classList.toggle('vault-mode',     mode === 'vault');
  document.querySelectorAll('.workspace-role-logout').forEach(function(button) {
    button.style.display = mode === 'viewer' ? 'none' : '';
  });

  // Sync home mode pill buttons (3 modes)
  var hpv  = document.getElementById('homePillViewer');
  var hpo  = document.getElementById('homePillOrganiser');
  var hpvm = document.getElementById('homePillVault');
  if (hpv)  hpv.classList.toggle('active',  mode === 'viewer');
  if (hpo)  hpo.classList.toggle('active',  mode === 'organiser');
  if (hpvm) hpvm.classList.toggle('active', mode === 'vault');

  // Apply viewer restrictions
  if (mode === 'viewer') {
    setViewerMode(true);
  } else {
    if (window._vSessionTabPinned) {
      if (typeof viewerStopPoll === 'function') viewerStopPoll();
      if (typeof _vHidePage     === 'function') _vHidePage();
    }
    setViewerMode(false);
  }
}

function setViewerMode(isViewer) {
  // Use body class -- all viewer restrictions handled via CSS + JS checks
  if (isViewer) {
    document.body.classList.add('viewer-mode');
    // Ensure we're on the club tab by default
    // settings no longer has tabs
  } else {
    document.body.classList.remove('viewer-mode');
  }

  // Lock/Unlock toggle button
  const lockBtn = document.getElementById('lockToggleBtn');
  if (lockBtn) {
    lockBtn.style.pointerEvents = isViewer ? 'none' : '';
    lockBtn.style.opacity       = isViewer ? '0.35' : '';
  }

  // New round / control buttons in rounds page
  ['#addRoundBtn', '#removeRoundBtn', '#minRoundsPlus', '#minRoundsMinus'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) { el.style.pointerEvents = isViewer ? 'none' : ''; el.style.opacity = isViewer ? '0.35' : ''; }
  });

  // Import/Add buttons -- hide entirely in viewer
  ['#openImportBtn', '.open-import-btn', '#addPlayersTypeBtn', '#addPlayersBrowseBtn'].forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      el.style.display = isViewer ? 'none' : '';
    });
  });
}

function closeModeSheet() {
  var o = document.getElementById('modeSelectOverlay');
  if (o) {
    o.classList.remove('scs-launch-first-paint');
    o.style.display = 'none';
  }
}

function _refreshWelcomeSubtitle() {
  var el = document.getElementById('welcomeTopbarSub');
  if (!el) return;
  var user = (typeof authGetUser === 'function') ? authGetUser() : null;
  el.textContent = (user && (user.nickname || user.email)) ? (user.nickname || user.email) : 'Choose Mode';
}

function openModeSwitcher() {
  // Use static overlay only -- update active mode highlight
  var overlay = document.getElementById('modeSelectOverlay');
  if (!overlay) return;
  _refreshWelcomeSubtitle();
  syncExperienceModeUI();
  // Update active state on mode buttons
  overlay.querySelectorAll('.ml-mode').forEach(function(btn) {
    btn.classList.remove('ml-active');
    if (btn.classList.contains(appMode)) btn.classList.add('ml-active');
  });
  // Sync language label
  if (typeof setLanguage === 'function') setLanguage(localStorage.getItem('appLanguage') || 'en');
  if (typeof mlSyncLangDisplay === 'function') mlSyncLangDisplay();
  overlay.style.display = 'flex';
  if (typeof window.scsPrefetchWelcomeHubData === 'function') {
    window.scsPrefetchWelcomeHubData().catch(function(error) {
      console.warn('Welcome hub refresh skipped:', error);
    });
  }

  // Apply lock UI for non-pro users
  var hasFull = typeof hasFullAccess === 'function' ? hasFullAccess() : true;
  ['organiser', 'vault'].forEach(function(mode) {
    var btn = overlay.querySelector('.ml-mode.' + mode);
    if (!btn) return;
    // Remove existing badge
    var existing = btn.querySelector('.pro-badge');
    if (existing) existing.remove();
    if (!hasFull) {
      btn.style.opacity = '0.5';
      btn.style.position = 'relative';
      var badge = document.createElement('span');
      badge.className = 'pro-badge';
      badge.style.cssText = 'position:absolute;top:8px;right:8px;background:#7c3aed;color:#fff;font-size:0.6rem;padding:2px 8px;border-radius:20px;font-weight:700;letter-spacing:0.5px;';
      badge.textContent = '🔒 PRO';
      btn.appendChild(badge);
    } else {
      btn.style.opacity = '1';
    }
  });
}

var _organiserWorkspaceOpening = false;

function organiserAccessEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showOrganiserAccessMenu(clubs) {
  return new Promise(function(resolve) {
    var existing = document.getElementById('organiserAccessOverlay');
    if (existing) existing.remove();
    var user = (typeof authGetUser === 'function') ? authGetUser() : null;
    var playerName = user && (user.nickname || user.displayName || user.email)
      ? (user.nickname || user.displayName || user.email)
      : ((typeof t === 'function' && t('playerRole')) || 'Player');
    var activeClub = (typeof getMyClub === 'function') ? getMyClub() : null;
    var cachedId = localStorage.getItem('kbrr_org_club_id') || '';
    var selectedId = clubs.some(function(club) { return club.id === String(cachedId); })
      ? String(cachedId)
      : (clubs.some(function(club) { return club.id === String((activeClub && activeClub.id) || ''); })
        ? String(activeClub.id)
        : clubs[0].id);
    var overlay = document.createElement('div');
    overlay.id = 'organiserAccessOverlay';
    overlay.className = 'organiser-access-overlay';
    overlay.innerHTML = `
      <section class="organiser-access-sheet" role="dialog" aria-modal="true" aria-labelledby="organiserAccessTitle">
        <button class="organiser-access-close" type="button" aria-label="Close">×</button>
        <div class="organiser-access-icon" aria-hidden="true">▦</div>
        <h2 id="organiserAccessTitle">${organiserAccessEscape((typeof t === 'function' && t('continueAsOrganiser')) || 'Continue as Organiser')}</h2>
        <p class="organiser-access-account">${organiserAccessEscape((typeof t === 'function' && t('signedInAs')) || 'Signed in as')} <strong>${organiserAccessEscape(playerName)}</strong></p>
        <div class="organiser-access-label">${organiserAccessEscape((typeof t === 'function' && t('selectClubTitle')) || 'Select Club')}</div>
        <div class="organiser-access-clubs">
          ${clubs.map(function(club) {
            var selected = club.id === selectedId;
            var accessLabel = club.source === 'vault'
              ? ((typeof t === 'function' && t('clubManagerRole')) || 'Club Manager')
              : ((typeof t === 'function' && t('clubMember')) || 'Club member');
            return `<button class="organiser-access-club${selected ? ' selected' : ''}" type="button" data-club-id="${organiserAccessEscape(club.id)}">
              <span class="organiser-access-club-mark" aria-hidden="true">🏸</span>
              <span class="organiser-access-club-copy"><strong>${organiserAccessEscape(club.name || club.id)}</strong><small>${organiserAccessEscape(accessLabel)}</small></span>
              <span class="organiser-access-radio" aria-hidden="true"></span>
            </button>`;
          }).join('')}
        </div>
        <div class="organiser-access-actions">
          <button class="organiser-access-continue" type="button">${organiserAccessEscape((typeof t === 'function' && t('continueBtn')) || 'Continue')} <span aria-hidden="true">→</span></button>
        </div>
      </section>`;
    document.body.appendChild(overlay);

    var finished = false;
    function finish(result) {
      if (finished) return;
      finished = true;
      overlay.remove();
      resolve(result);
    }
    overlay.querySelectorAll('.organiser-access-club').forEach(function(button) {
      button.addEventListener('click', function() {
        selectedId = button.getAttribute('data-club-id') || selectedId;
        overlay.querySelectorAll('.organiser-access-club').forEach(function(item) {
          item.classList.toggle('selected', item === button);
        });
      });
    });
    overlay.querySelector('.organiser-access-close').addEventListener('click', function() { finish(null); });
    overlay.querySelector('.organiser-access-continue').addEventListener('click', function() {
      finish(clubs.find(function(club) { return club.id === selectedId; }) || clubs[0]);
    });
    overlay.addEventListener('click', function(event) { if (event.target === overlay) finish(null); });
  });
}

async function openOrganiserWorkspaceForMember(selectedClubId) {
  if (_organiserWorkspaceOpening) return;
  _organiserWorkspaceOpening = true;
  try {
    var clubs = await getOrganiserEligibleClubs();
    if (!clubs.length) {
      if (typeof showToast === 'function') {
        showToast((typeof t === 'function' && t('organiserMembershipRequired')) || 'Join a club as a player to use Organiser.');
      }
      return;
    }
    var selectedClub = selectedClubId
      ? clubs.find(function(club) { return club.id === String(selectedClubId); })
      : null;
    if (!selectedClub) selectedClub = await showOrganiserAccessMenu(clubs);
    if (!selectedClub) return;
    var club = await syncOrganiserMembershipAccess(null, selectedClub.id);
    if (!club || !club.id) return;
    if (typeof setMyClub === 'function') setMyClub(club.id, club.name || '');
    localStorage.setItem('kbrr_club_mode', club.source === 'vault' ? 'admin' : 'user');
    var overlay = document.getElementById('modeSelectOverlay');
    if (overlay) {
      overlay.classList.remove('scs-launch-first-paint');
      overlay.style.display = 'none';
    }
    appMode = 'organiser';
    sessionStorage.setItem('appMode', 'organiser');
    localStorage.setItem('kbrr_app_mode', 'organiser');
    applyMode('organiser');
    updateModePill('organiser');
    if (typeof showHomeScreen === 'function') showHomeScreen();
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message || 'Could not open Organiser');
  } finally {
    _organiserWorkspaceOpening = false;
    updateWelcomeWorkspaceClubNames();
  }
}

function switchMode(mode) {
  if (!experienceAllowsRole(mode)) {
    if (typeof showToast === 'function') showToast('This hub is hidden by your Experience Mode setting');
    return;
  }
  // Check subscription access
  if (typeof canAccessMode === 'function' && !canAccessMode(mode)) {
    if (typeof showModeUpgradePrompt === 'function') showModeUpgradePrompt(mode);
    return;
  }

  // Protected workspaces must never bypass the account login when opened
  // from Welcome or from the mode switcher.
  if (mode !== 'viewer' &&
      typeof authIsLoggedIn === 'function' &&
      !authIsLoggedIn()) {
    sessionStorage.setItem('scs_pending_workspace', mode);
    welcomeSelectedWorkspace = mode;
    if (typeof authShowScreen === 'function') authShowScreen('login');
    return;
  }

  // Viewer -- no login or club needed
  if (mode === 'viewer') {
    const overlay = document.getElementById('modeSelectOverlay');
    if (overlay) {
      overlay.classList.remove('scs-launch-first-paint');
      overlay.style.display = 'none';
    }
    appMode = mode;
    sessionStorage.setItem('appMode', mode);
    localStorage.setItem('kbrr_app_mode', mode);
    applyMode(mode);
    updateModePill(mode);
    if (typeof showHomeScreen === 'function') showHomeScreen();
    if (typeof window.scsNotificationsCheckNow === 'function') {
      setTimeout(function() { window.scsNotificationsCheckNow(); }, 350);
    }
    return;
  }

  // Organiser -- available to every signed-in player who belongs to the club.
  if (mode === 'organiser') {
    openOrganiserWorkspaceForMember(window.__scsWelcomeOrganiserChoice || '');
    return;
  }

  // Vault -- independent session flag, admin password only
  if (mode === 'vault') {
    requestVaultMode();
    return;
  }
}

function updateModePill(mode) {
  const icons  = { viewer: '🏸', organiser: '🏆', vault: '🔑' };
  const labels = { viewer: t('playerRole'), organiser: t('organiserRole'), vault: t('clubManagerRole') };
  const colors = { viewer: '#6c8cff', organiser: '#2dce89', vault: '#f5a623' };
  const icon  = icons[mode]  || '🏸';
  const label = labels[mode] || 'Mode';
  const color = colors[mode] || '#6c8cff';
  ['', '2'].forEach(suffix => {
    const iconEl  = document.getElementById('modePillIcon'  + suffix);
    const labelEl = document.getElementById('modePillLabel' + suffix);
    const btnEl   = document.getElementById('modePillBtn'   + suffix);
    if (iconEl)  iconEl.textContent  = icon;
    if (labelEl) labelEl.textContent = label;
    // modePillBtn2 (main scs-topbar): apply full pill styling
    if (btnEl && suffix === '2') { btnEl.style.color = color; btnEl.style.borderColor = color + '44'; btnEl.style.background = color + '11'; }
    // modePillBtn (home topbar): reset any previously applied inline styles
    if (btnEl && suffix === '') { btnEl.style.color = ''; btnEl.style.borderColor = ''; btnEl.style.background = ''; }
  });
  // Update dynamic subtitle on both topbars
  var subtitle = '';
  if (mode === 'viewer') {
    var accountUser = (typeof authGetUser === 'function') ? authGetUser() : null;
    var player = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
    subtitle = (accountUser && (accountUser.nickname || accountUser.displayName)) ||
      (player && (player.displayName || player.name || player.nickname)) || '';
  } else if (mode === 'organiser' || mode === 'vault') {
    var club = (typeof getMyClub === 'function') ? getMyClub() : null;
    subtitle = (club && club.name) || '';
  }
  ['modePillSub', 'modePillSub2'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = subtitle;
  });
  // Update Settings page mode value
  const settingsModeEl = document.getElementById('settingsModeValue');
  if (settingsModeEl) { settingsModeEl.textContent = icon + ' ' + label; settingsModeEl.style.color = color; }
  // Sync scs-topbar icon bg colour
  document.querySelectorAll('.scs-topbar-icon-wrap').forEach(function(el) {
    el.style.background = color + '28';
  });
}

function initModeOnLoad() {
  // A new document means a genuine app launch/reload. Always begin at Welcome.
  // Returning from the background does not reload the document, so the current
  // page and all in-memory state remain exactly where the user left them.
  var homeEl = document.getElementById('homePageOverlay');
  if (homeEl) homeEl.style.display = 'none';
  document.querySelectorAll('.page').forEach(function(page) {
    page.style.display = 'none';
  });

  var overlay = document.getElementById('modeSelectOverlay');
  if (overlay) {
    // The first-paint class exists only to prevent an old workspace flashing
    // before deferred JavaScript is ready. Release it now, while keeping
    // Welcome visible and fully interactive.
    overlay.classList.remove('scs-launch-first-paint');
    overlay.style.display = 'flex';
  }

  // Apply saved visual preferences and preselect the user's previous workspace,
  // but never enter that workspace automatically on a fresh launch.
  loadHomeStyle();
  var savedMode = localStorage.getItem('kbrr_app_mode') || 'viewer';
  if (!experienceAllowsRole(savedMode)) {
    savedMode = 'viewer';
    localStorage.setItem('kbrr_app_mode', savedMode);
  }
  appMode = savedMode;
  welcomeSelectedWorkspace = savedMode;
  updateModePill(savedMode);
  if (typeof welcomeSelectWorkspace === 'function') welcomeSelectWorkspace(savedMode);
  if (typeof welcomeApplyAllHubData === 'function') welcomeApplyAllHubData();

  initAppFlow();
}

async function initAppFlow() {
  // ── Demo mode auto-resume ──
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    var user = typeof authGetUser === 'function' ? authGetUser() : null;
    if (user && user.id) {
      // Resume demo — restart timer
      if (typeof _demoStartTimer === 'function') _demoStartTimer();
      var modeOverlay = document.getElementById('modeSelectOverlay');
      if (modeOverlay) modeOverlay.style.display = 'flex';
      if (typeof mlSyncLangDisplay === 'function') mlSyncLangDisplay();
      return;
    } else {
      // Demo session expired — clean up
      localStorage.removeItem('scs_demo_mode');
    }
  }

  // ── Step 1: Check auth ──
  if (typeof authIsLoggedIn === 'function' && !authIsLoggedIn()) {
    authShowScreen('welcome');
    return;
  }

  // ── Step 2: Verify subscription with server ──
  // Restore cross-device club grants for an account that was already signed in.
  await restoreUserClubRoles().catch(function(e) {
    console.warn('Club role restore skipped:', e.message || e);
  });

  const subscriptionUser = typeof authGetUser === 'function' ? authGetUser() : null;
  if (subscriptionUser && typeof verifyAccessWithServer === 'function') {
    await verifyAccessWithServer(subscriptionUser);
  }

  // ── Step 3: Session resume — only on app open, only if already in organiser mode ──
  const savedMode     = localStorage.getItem('kbrr_app_mode');
  const orgVerified   = sessionStorage.getItem('scs_organiser_verified') === '1' ||
                        localStorage.getItem('scs_organiser_verified')   === '1';
  if (false && savedMode === 'organiser' && experienceAllowsRole('organiser') && orgVerified) {
    var restoredOrgClubId = localStorage.getItem('kbrr_org_club_id') || '';
    var restoredOrgClubName = localStorage.getItem('kbrr_org_club_name') || '';
    if (restoredOrgClubId && typeof setMyClub === 'function') setMyClub(restoredOrgClubId, restoredOrgClubName);
    applyMode('organiser');
    updateModePill('organiser');
    appMode = 'organiser';
    // Await resume — if session restored, skip mode select
    if (typeof checkAndResume === 'function') {
      const resumed = await checkAndResume();
      if (resumed) return;
    }
  }

  // ── Step 4: Normal startup — show mode select ──
  var overlay = document.getElementById('modeSelectOverlay');
  if (overlay) overlay.style.display = 'flex';
  syncExperienceModeUI();
  _refreshWelcomeSubtitle();
  if (typeof mlSyncLangDisplay === 'function') mlSyncLangDisplay();
  if (typeof renderLauncherStartSessionCard === 'function') {
    renderLauncherStartSessionCard();
    setTimeout(renderLauncherStartSessionCard, 800);
  }
}

function showOnboardingOverlay(reason) {
  var overlay = document.getElementById('onboardingOverlay');
  var title   = document.getElementById('onboardingTitle');
  var msg     = document.getElementById('onboardingMsg');
  var btn     = document.getElementById('onboardingBtn');
  if (!overlay) return;

  var goToVault = function() {
    overlay.style.display = 'none';
    // Hide home overlay if visible
    var homeEl = document.getElementById('homePageOverlay');
    if (homeEl) homeEl.style.display = 'none';
    // Hide mode select if visible
    var modeEl = document.getElementById('modeSelectOverlay');
    if (modeEl) modeEl.style.display = 'none';
    // Show vault page
    showPage('vaultPage', null);
  };

  if (reason === 'notLoggedIn') {
    if (title) title.textContent = t('welcomeToApp');
    if (msg)   msg.textContent = t('connectClubToStart');
    if (btn)   { btn.textContent = 'Connect to Club'; btn.onclick = goToVault; }
  } else if (reason === 'noPlayers') {
    if (title) title.textContent = t('noPlayersFoundWarn');
    if (msg)   msg.textContent   = t('noPlayersYetVault');
    if (btn)   { btn.textContent = t('goToVault'); btn.onclick = goToVault; }
  }
  overlay.style.display = 'flex';
}

/* ============================================================
   MAIN -- Navigation, tab access, scheduler init, round progression
   File: main.js
   ============================================================ */

let sessionFinished = false;
let lastPage = null;



function isPageVisible(pageId) {
  const el = document.getElementById(pageId);
  return el && el.style.display !== 'none';
}








document.addEventListener('DOMContentLoaded', async () => {
  // License check — must have valid key to use app
  // Check license on every app open
  (async function() {
    const subscriptionUser = typeof authGetUser === 'function' ? authGetUser() : null;
    const legacyEmail = localStorage.getItem('scs_sub_email');
    if ((subscriptionUser || legacyEmail) && typeof checkLicense === 'function') {
      await checkLicense(subscriptionUser || legacyEmail);
    } else {
      if (typeof _initTrial === 'function') _initTrial();
      if (typeof subShowTrialBanner === 'function') subShowTrialBanner();
    }
  })();
  // Restore theme and font size from saved prefs FIRST
  if (typeof initTheme    === 'function') initTheme();
  if (typeof initFontSize === 'function') initFontSize();
  syncExperienceModeUI();

  // Complete social OAuth before normal restored-session or launcher handling.
  if (typeof authHandleGoogleCallback === 'function') {
    var googleCallbackHandled = await authHandleGoogleCallback();
    if (googleCallbackHandled) return;
  }
  if (typeof authHandleLineCallback === 'function') {
    var lineCallbackHandled = await authHandleLineCallback();
    if (lineCallbackHandled) return;
  }

  // Validate a restored login before the welcome/workspace page is opened.
  // A token replaced by another device is cleared immediately.
  if (typeof authIsLoggedIn === 'function' && authIsLoggedIn()) {
    if (typeof authVerifySession === 'function') {
      var startupSessionValid = await authVerifySession();
      if (!startupSessionValid) return;
    }
    if (typeof _startSessionWatch === 'function') _startSessionWatch();
    if (typeof restoreUserClubRoles === 'function') {
      await restoreUserClubRoles().catch(function(){});
    }
  }

  // Download the first-use data for all three workspaces while the startup
  // ring is still covering the UI. Switching modes will therefore render the
  // prepared data immediately, followed by a quiet sync for freshness.
  if (typeof window.scsPrefetchAllWorkspaceData === 'function') {
    await window.scsPrefetchAllWorkspaceData();
  }

  // Show mode select only after restored account/workspace state and all
  // workspace caches are settled.
  initModeOnLoad();
  syncExperienceModeUI();
  if (typeof window.scsFinishStartup === 'function') window.scsFinishStartup();

  // schedulerState starts empty -- user imports players fresh each session
  consolidateMasterDB();
  updateRoundsPageAccess();
  updateSummaryPageAccess();
  // Init Supabase admin state (token + club)
  if (typeof clubAdminInit === "function") clubAdminInit();
  // Sync Supabase players into local history (silent, background)
  syncToLocal();
  // Sync all global players into local cache (for offline import)
  if (typeof syncGlobalPlayersCache === "function") syncGlobalPlayersCache();
  // Clean up stale live_sessions from previous days
  if (typeof cleanupLiveSessions === "function") cleanupLiveSessions();

  // ── Profile gate handled by selectMode() after mode is chosen ──

  // Auto end session if no round activity for 1 hour
  const AUTO_END_MS = 60 * 60 * 1000; // 1 hour
  setInterval(async () => {
    // Only trigger if there are active rounds with scored games
    const hasGames = typeof allRounds !== "undefined" &&
      allRounds.some(r => (r.games || r).some(g => g.winner));
    if (!hasGames) return;

    // Check last round update time from live_sessions
    try {
      const club = (typeof getMyClub === "function") ? getMyClub() : { id: null };
      if (!club.id) return;
      const today = (typeof localDateStr === 'function') ? localDateStr() : new Date().toISOString().split("T")[0];
      const rows  = await sbGet("live_sessions",
        `club_id=eq.${club.id}&date=eq.${today}&order=updated_at.desc&limit=1`);
      if (!rows || !rows.length) return;

      const lastUpdate = new Date(rows[0].updated_at).getTime();
      if (Date.now() - lastUpdate < AUTO_END_MS) return;

      // 1hr idle -- warn organiser, don't silently end
      console.log('Session idle for 1hr — prompting organiser');
      if (document.getElementById('roundsPage') &&
          document.getElementById('roundsPage').style.display !== 'none') {
        // Only show if currently on rounds page
        var existing = document.getElementById('scs-idle-warning');
        if (!existing) {
          var warn = document.createElement('div');
          warn.id = 'scs-idle-warning';
          warn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#e63757;color:#fff;padding:12px 20px;border-radius:12px;font-size:0.85rem;font-weight:600;z-index:9999;text-align:center;max-width:280px;box-shadow:0 4px 16px rgba(0,0,0,0.4);';
          warn.innerHTML = '⚠️ Session idle for 1 hour.<br><span style="font-weight:400;font-size:0.8rem;">Tap End when finished to save results.</span>';
          warn.onclick = function() { warn.remove(); };
          document.body.appendChild(warn);
          setTimeout(function() { if (warn.parentNode) warn.remove(); }, 10000);
        }
      }
    } catch(e) { /* silent */ }
  }, 5 * 60 * 1000); // check every 5 minutes
});

window.addEventListener('beforeunload', () => {
  consolidateMasterDB();   // merge any new players added during session on close
  // Note: do NOT complete session on close — organiser may reopen and resume.
  // Session only completes when organiser explicitly taps End.
});

// ── Sync when back online ──
window.addEventListener('online', async () => {
  console.log('Back online -- flushing sync queue...');
  if (typeof flushSyncQueue === 'function') await flushSyncQueue();
  if (typeof syncToLocal    === 'function') await syncToLocal();
});

/* =========================
   CONSOLIDATE MASTER DB
   Merges players from ALL sources into newImportHistory.
   Safe -- never overwrites existing ratings, only adds missing players.
   Called on app open and close.
========================= */
function consolidateMasterDB() {
  try {
    const master   = JSON.parse(localStorage.getItem("newImportHistory")      || "[]");
    const favs     = JSON.parse(localStorage.getItem("newImportFavorites")     || "[]");
    const sets     = JSON.parse(localStorage.getItem("newImportFavoriteSets")  || "[]");
    const session  = JSON.parse(localStorage.getItem("schedulerPlayers")       || "[]");

    // Build lookup of existing master players (preserve their ratings)
    const masterMap = new Map();
    master.forEach(p => {
      if (p && p.displayName)
        masterMap.set(p.displayName.trim().toLowerCase(), p);
    });

    // Collect players from favorites and session only -- NOT from sets
    // Sets are separate and should not pollute history
    const allSources = [
      ...favs,
      ...session.map(p => ({ displayName: p.name, gender: p.gender })),
    ];

    // Add missing players -- never overwrite existing
    allSources.forEach(p => {
      if (!p || !p.displayName) return;
      const key = p.displayName.trim().toLowerCase();
      if (!masterMap.has(key)) {
        masterMap.set(key, {
          displayName: p.displayName.trim(),
          gender: p.gender || "Male",
          rating: 1.0   // default for new players only
        });
      }
    });

    const merged = Array.from(masterMap.values());
    localStorage.setItem("newImportHistory", JSON.stringify(merged));

    // Update in-memory historyPlayers if available
    if (newImportState) newImportState.historyPlayers = merged;
  } catch(e) {
    console.error("consolidateMasterDB error", e);
  }
}

/* ============================================================
   RATING -- SINGLE DOOR
   
   Rule: activeRating is computed ONCE at sync time in syncToLocal.
   Everything else reads newImportHistory[].activeRating -- mode-blind.

   getActiveRating(name)     -- only READ path
   setActiveRating(name,val) -- only WRITE path (in-memory + localStorage)
   syncRatings()             -- refreshes all visible badges
   
   Mode logic lives ONLY in syncToLocal (read) and dbSyncRatings (write).
   ============================================================ */

function getRatingMode() {
  return 'local'; // global mode blocked until fully tested
}

function setRatingMode(mode) {
  localStorage.setItem('kbrr_rating_mode', mode);
  syncRatings();
}

/* READ -- just reads activeRating, no mode logic here */
function isGuestPlayerName(name) {
  try {
    const key = String(name || '').trim().toLowerCase();
    const ap = schedulerState.allPlayers.find(p => String(p.name || '').trim().toLowerCase() === key);
    return !!(ap && (ap.guest || ap.unrated)) || /\(guest(?:\s+[a-z0-9]+)?\)$/i.test(String(name || ''));
  } catch(e) {
    return /\(guest(?:\s+[a-z0-9]+)?\)$/i.test(String(name || ''));
  }
}

function getActiveRating(name) {
  try {
    if (isGuestPlayerName(name)) return null;
    const key = name.trim().toLowerCase();
    // 1. Check allPlayers in-memory first (most current during active session)
    const ap = schedulerState.allPlayers.find(p => p.name.trim().toLowerCase() === key);
    if (ap && ap.activeRating !== undefined && ap.activeRating !== null) return ap.activeRating;
    // 2. Fallback to newImportHistory
    const master = JSON.parse(localStorage.getItem("newImportHistory") || "[]");
    const hp = master.find(h => h.displayName.trim().toLowerCase() === key);
    return (hp && hp.activeRating !== undefined) ? hp.activeRating : 1.0;
  } catch(e) { return 1.0; }
}

/* WRITE -- updates in-memory and localStorage, mode-blind */
function setActiveRating(name, val) {
  try {
    if (isGuestPlayerName(name)) return;
    const key     = name.trim().toLowerCase();
    const clamped = Math.min(5.0, Math.max(1.0, Math.round(val * 10) / 10));

    // Update allPlayers in-memory
    const ap = schedulerState.allPlayers.find(p => p.name.trim().toLowerCase() === key);
    if (ap) ap.activeRating = clamped;

    // Persist to newImportHistory
    const master = JSON.parse(localStorage.getItem("newImportHistory") || "[]");
    const hp = master.find(h => h.displayName.trim().toLowerCase() === key);
    if (hp) {
      hp.activeRating = clamped;
      localStorage.setItem("newImportHistory", JSON.stringify(master));
      // Keep in-memory historyPlayers in sync too
      if (newImportState && newImportState.historyPlayers) {
        const mp = newImportState.historyPlayers.find(h => h.displayName.trim().toLowerCase() === key);
        if (mp) mp.activeRating = clamped;
      }
    }
  } catch(e) { console.error("setActiveRating error", e); }
}

/* Legacy aliases -- safe to leave, all point to same door */
function getRating(name)         { return getActiveRating(name); }
function setRating(name, rating) { setActiveRating(name, rating); }
function getClubRating(name)     { return getActiveRating(name); }
function setClubRating(name, r)  { setActiveRating(name, r); }

function syncRatings() {
  document.querySelectorAll(".rating-badge[data-player]").forEach(badge => {
    const name = badge.getAttribute("data-player");
    if (!name) return;
    if (isGuestPlayerName(name)) {
      badge.removeAttribute("data-player");
      badge.textContent = "guest";
      return;
    }
    const rating = getActiveRating(name);
    badge.textContent = Number.isFinite(rating) ? rating.toFixed(1) : "guest";
  });
}

function syncPlayersFromMaster() { syncRatings(); }


function updateRoundsPageAccess() {
  const block = schedulerState.activeplayers.length < 4;
  const roundsTab = document.getElementById('tabBtnRounds');

  if (!roundsTab) return;

  roundsTab.style.pointerEvents = block ? 'none' : 'auto';
  roundsTab.style.opacity = block ? '0.4' : '1';
  roundsTab.setAttribute('aria-disabled', block);

  if (block && isPageVisible('roundsPage')) {
    showPage('playersPage', null);
  }
}


function updateSummaryPageAccess() {
  const hasRounds = Array.isArray(allRounds) && allRounds.length > 0;
  const summaryTab = document.getElementById('tabBtnSummary');
  const block = !hasRounds;

  if (!summaryTab) return;

  summaryTab.style.pointerEvents = block ? 'none' : 'auto';
  summaryTab.style.opacity = block ? '0.4' : '1';
  summaryTab.setAttribute('aria-disabled', block);

  if (block && isPageVisible('summaryPage')) {
    showPage('playersPage', null);
  }
}

function showPage(pageID, el) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');

  // Show selected page
  document.getElementById(pageID).style.display = 'block';

  // Hide both top bars while inside a page
  document.querySelectorAll('.home-topbar, .top-bar').forEach(b => b.style.display = 'none');

  // Update active tab styling
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  if (el) {
    el.classList.add('active');
    // Scroll active tab into view smoothly
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  // Restore Session tab if a session is currently pinned open
  if (window._vSessionTabPinned) {
    const vBtn = document.getElementById('tabBtnViewer');
    if (vBtn) vBtn.style.display = '';
  }

  // Sync all rating badges on the newly visible page
  syncRatings();

  // Players page -- update list on open
  if (pageID === 'playersPage') {
    if (typeof updatePlayerList === 'function') updatePlayerList();
  }

  // Fixed Pairs page -- refresh selectors on open
  if (pageID === 'fixedPairsPage') {
    if (typeof updateFixedPairSelectors === 'function') updateFixedPairSelectors();
    if (typeof renderFixedPairs === 'function') renderFixedPairs();
  }

  // ➜ Additional action when roundsPage is opened
  if (pageID === "roundsPage") {
    if (sessionFinished) {
      console.warn("Rounds already finished");
      return;
    }
    updateMixedSessionFlag();
    if (allRounds.length <= 1) {
      resetRounds();
    } else {
      // If court count changed, regenerate — otherwise just re-render
      const currentCourts = parseInt(document.getElementById('num-courts')?.textContent || '1');
      if (currentCourts !== schedulerState.numCourts) {
        if (typeof goToRounds === 'function') goToRounds();
      } else {
        if (typeof showRound === 'function') showRound(currentRoundIndex);
      }
    }
    updateSessionLiveBar();
  }

  if (pageID === "summaryPage") {
    if (typeof renderSummaryFromSession === 'function') renderSummaryFromSession();
  }

  if (pageID === "vaultReportPage") {
    // Update month label
    const d = new Date();
    const label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
    const titleEl = document.getElementById('reportMonthTitle');
    const subEl   = document.getElementById('reportMonthSub');
    if (titleEl) titleEl.textContent = label + ' ' + (t('report') || 'Report');
    if (subEl)   subEl.textContent   = t('monthlyStats') || 'Monthly stats';
    // Render preview
    if (typeof reportFetchData === 'function') {
      const preview   = document.getElementById('reportPreview');
      const statusEl  = document.getElementById('reportStatus');

      // Step 1 — show local data immediately (never blank)
      try {
        const localPlayers = JSON.parse(localStorage.getItem('newImportHistory') || '[]');
        if (localPlayers.length && preview) {
          const localData = {
            club: (typeof getMyClub === 'function') ? getMyClub() : { name: '' },
            month: reportCurrentMonth(),
            monthLabel: reportMonthLabel(),
            usingLocal: true,
            players: localPlayers
              .filter(p => p.displayName || p.name)
              .map(p => ({
                name:        p.displayName || p.name || '',
                rating:      parseFloat(p.activeRating || p.rating) || 1.0,
                points:      parseFloat(p.club_points) || 0,
                monthWins:   0, monthLosses: 0, monthGames: 0,
                monthCost:   0, sessCount: 0, winRate: 0
              }))
              .sort((a, b) => b.rating - a.rating)
          };
          const iframe = document.createElement('iframe');
          iframe.style.cssText = 'width:100%;height:80vh;border:none;border-radius:16px;';
          iframe.srcdoc = reportBuildHTML(localData);
          preview.innerHTML = '';
          preview.appendChild(iframe);
          if (statusEl) { statusEl.textContent = '📱 Local data — syncing...'; statusEl.style.color = 'var(--muted)'; }
        }
      } catch(e) { /* silent */ }

      // Step 2 — fetch from server and update
      reportFetchData().then(data => {
        if (preview) {
          const iframe = document.createElement('iframe');
          iframe.style.cssText = 'width:100%;height:80vh;border:none;border-radius:16px;';
          iframe.srcdoc = reportBuildHTML(data);
          preview.innerHTML = '';
          preview.appendChild(iframe);
        }
        if (statusEl) { statusEl.textContent = data.usingLocal ? '⚠️ Offline — local data only' : ''; statusEl.style.color = '#f5a623'; }
      }).catch(e => {
        // Server failed — local data already showing, just update status
        if (statusEl) { statusEl.textContent = '⚠️ Offline — showing local data'; statusEl.style.color = '#f5a623'; }
      });
    }
  }

  if (pageID === "vaultReport2Page") {
    if (typeof r2Init === 'function') r2Init();
  }

  // QC — start watching current mode
  if (pageID === 'homeScreen' || pageID === 'viewerHome') {
    if (typeof qcStart === 'function') qcStart('viewer');
  } else if (pageID === 'playersPage' || pageID === 'roundsPage') {
    if (typeof qcStart === 'function') qcStart('organiser');
  } else if (pageID === 'vaultPage' || pageID === 'vaultRegisterPage') {
    if (typeof qcStart === 'function') qcStart('vault');
  }

  if (pageID === "myCardPage") {
    if (typeof renderMyCard === 'function') renderMyCard();
  }

  if (pageID === "recentMatchesPage") {
    if (typeof renderMyCard === 'function') renderMyCard();
  }

  if (pageID === "joinClubPage") {
    if (typeof joinClubPageOpen === 'function') joinClubPageOpen();
  }

  if (pageID === "settingsPage") {
    if (typeof subShowTrialBanner === 'function') subShowTrialBanner();
    updateModePill(localStorage.getItem('kbrr_app_mode') || 'organiser');
    loadHomeStyle();
    if (typeof appearSyncFromSaved === 'function') appearSyncFromSaved();
    syncExperienceModeUI();
    // Track that settings is the source for sub-pages
    if (typeof _navSource !== 'undefined') _navSource = 'settings';
  }

  if (pageID === "helpPage") {
    if (typeof onHelpTabOpen === "function") onHelpTabOpen();
  }

  if (pageID === "dashboardPage") {
    if (typeof renderDashboard === "function") renderDashboard();
  } else {
    // Stop dashboard poll when navigating away
    if (typeof dashboardStopPoll === 'function') dashboardStopPoll();
  }

  if (pageID === "vaultPage") {
    if (typeof clubLoginRefresh === 'function') clubLoginRefresh();
    if (typeof viewerLoadClubs === 'function') viewerLoadClubs();
    if (typeof sbPopulateDeleteDropdown === 'function') sbPopulateDeleteDropdown();
  }

  if (pageID === "vaultVenuesPage") {
    if (typeof vaultVenuesOpenPage === 'function') vaultVenuesOpenPage();
  }

  if (pageID === "vaultPlayingPage") {
    if (typeof playerPlayingRenderList === 'function') playerPlayingRenderList();
  }

  if (pageID === "vaultRegisterPage") {
    if (typeof vaultRenderRegister === 'function') vaultRenderRegister();
  }

  if (pageID === "vaultModifyPage") {
    if (typeof vaultRenderModify === 'function') vaultRenderModify();
  }

  if (pageID === "vaultRequestsPage") {
    if (typeof vaultLoadRequests === 'function') vaultLoadRequests();
  }

  if (pageID === "vaultClubMgmtPage") {
    if (typeof clubLoginRefresh === 'function') clubLoginRefresh();
    // Always show delete panel only
    ['Connect','Create','Delete'].forEach(function(p) {
      var el = document.getElementById('clubMgmt' + p + 'Panel');
      if (el) el.style.display = p === 'Delete' ? 'block' : 'none';
    });
  }

  if (pageID === "orgClubMgmtPage") {
    if (typeof orgClubLoginRefresh === 'function') orgClubLoginRefresh();
    if (typeof orgLoadClubs === 'function') orgLoadClubs();
  }

  // Update last visited page
  lastPage = pageID;
}

let IS_MIXED_SESSION = false;

function updateMixedSessionFlag() {
  let hasMale = false;
  let hasFemale = false;

  for (const p of schedulerState.allPlayers) {
    if (p.gender === "Male") hasMale = true;
    if (p.gender === "Female") hasFemale = true;
    if (hasMale && hasFemale) break;
  }

  IS_MIXED_SESSION = hasMale && hasFemale;
}

	





















  








// Page initialization
function initPage() {
  document.getElementById("playersPage").style.display = 'block';
  document.getElementById("roundsPage").style.display = 'none';
}

/* ============================================================
   SYNC -- Server is master.
   THIS is the only place mode logic runs for READING.
   Pulls from Supabase → picks correct field based on mode → 
   writes as activeRating → everything else is mode-blind.
============================================================ */
async function syncToLocal() {
  const club = (typeof getMyClub === "function") ? getMyClub() : { id: null };
  setSyncIndicator(t("syncing"), "#aaa");

  if (!club.id) {
    setSyncIndicator(t("noClubSelectedWarn"), "#e6a817");
    return;
  }

  try {
    // Flush any offline-queued writes first
    if (typeof flushSyncQueue === "function") await flushSyncQueue();

    const players = await dbGetPlayers(true);
    if (!players || !players.length) {
      setSyncIndicator(t("noPlayersFoundWarn"), "#e6a817");
      return;
    }

    // Always use clubRating (club_rating column) as the active rating
    const synced = players.map(gp => {
      const activeRating = parseFloat(gp.clubRating) || parseFloat(gp.rating) || 1.0;
      return {
        displayName:  gp.name.trim(),
        gender:       gp.gender || "Male",
        rating:       parseFloat(gp.rating)     || 1.0,
        clubRating:   parseFloat(gp.clubRating) || 1.0,
        activeRating,
        id:           gp.id
      };
    });

    // Server wins -- write to local cache
    localStorage.setItem("newImportHistory", JSON.stringify(synced));

    // Update in-memory state
    if (newImportState) {
      newImportState.historyPlayers = synced;
      if (typeof newImportRefreshSelectCards === "function") newImportRefreshSelectCards();
    }

    // Update allPlayers in-memory activeRating (safe -- doesn't reset active session games)
    if (schedulerState && schedulerState.allPlayers) {
      synced.forEach(sp => {
        const ap = schedulerState.allPlayers.find(
          p => p.name.trim().toLowerCase() === sp.displayName.trim().toLowerCase()
        );
        if (ap) ap.activeRating = sp.activeRating;
      });
    }

    syncRatings();

    const count = synced.length;
    const msg   = `✅ ${count} ${t("playerPlural")} synced · ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
    localStorage.setItem("kbrr_last_sync", JSON.stringify({ msg, color: "#2dce89" }));
    setSyncIndicator(msg, "#2dce89");

  } catch (e) {
    console.warn("syncToLocal failed:", e.message);
    const msg = t("offlineCache");
    localStorage.setItem("kbrr_last_sync", JSON.stringify({ msg, color: "#e6a817" }));
    setSyncIndicator(msg, "#e6a817");
  }
}

function setSyncIndicator(msg, color) {
  const indicator = document.getElementById("sbSyncStatus");
  if (indicator) { indicator.textContent = msg; indicator.style.color = color; }
}

function restoreSyncIndicator() {
  try {
    const saved = localStorage.getItem("kbrr_last_sync");
    if (saved) {
      const { msg, color } = JSON.parse(saved);
      setSyncIndicator(msg, color);
    }
  } catch(e) {}
}



/* =============================================================
   SESSION LIVE BAR
============================================================= */
function updateSessionLiveBar() {
  const bar = document.getElementById('sessionLiveBar');
  if (!bar) return;
  const sessionId = (typeof getMySessionId === 'function') ? getMySessionId() : null;
  const hasRounds = typeof allRounds !== 'undefined' && allRounds.length > 0;
  bar.style.display = (sessionId || hasRounds) ? 'flex' : 'none';
}

/* =============================================================
   VAULT MODE -- Admin password gate
============================================================= */
function requestVaultMode() {
  // Pro subscription required for Vault mode
  if (typeof canAccessMode === 'function' && !canAccessMode('vault')) {
    if (typeof showModeUpgradePrompt === 'function') showModeUpgradePrompt('vault');
    return;
  }

  // Already verified as admin this session — go straight in
  if (hasVerifiedWorkspaceRole('vault')) {
    // Restore sessionStorage flag for this session
    sessionStorage.setItem('scs_vault_verified', '1');
    var vaultClubId = localStorage.getItem('kbrr_vault_club_id') || '';
    var vaultClubName = localStorage.getItem('kbrr_vault_club_name') || '';
    var club = vaultClubId ? { id: vaultClubId, name: vaultClubName } : null;
    if (club && club.id) {
      if (typeof setMyClub === 'function') setMyClub(club.id, club.name || '');
      const overlay = document.getElementById('modeSelectOverlay');
      if (overlay) {
        overlay.classList.remove('scs-launch-first-paint');
        overlay.style.display = 'none';
      }
      appMode = 'vault';
      sessionStorage.setItem('appMode', 'vault');
      localStorage.setItem('kbrr_app_mode', 'vault');
      applyMode('vault');
      updateModePill('vault');
      if (typeof showHomeScreen === 'function') showHomeScreen();
      return;
    }
  }

  // Not vault-verified — always show club setup sheet to demand admin password
  _showClubSetupSheet('vault');
}

/* =============================================================
   CLUB SETUP SHEET -- shown when entering Organiser or Vault without a club
   Provides: Join existing club | Create new club
============================================================= */
var _clubSetupTargetMode = null; // mode to enter after club is set up
var _clubSetupCreateEmail = '';  // email during create-club OTP flow

function _showClubSetupSheet(targetMode) {
  if (targetMode === 'organiser') {
    openOrganiserWorkspaceForMember();
    return;
  }
  _clubSetupTargetMode = targetMode;
  const existing = document.getElementById('clubSetupSheetOverlay');
  if (existing) existing.remove();

  const modeLabel = targetMode === 'vault' ? t('vaultManager') : t('roundOrganiser');
  const connectText = targetMode === 'organiser'
    ? (t('clubConnectOrganiserMsg') || 'You need to be connected to a club. Join an existing club. To create a new club, switch to Vault mode.')
    : (t('clubConnectVaultMsg') || 'You need to be connected to a club. Join an existing club, or create a club under Vault.');
  const joinPasswordPh = targetMode === 'vault'
    ? (t('clubAdminPasswordPh') || 'Club Admin password')
    : (t('clubOrganiserPasswordPh') || 'Club Organiser password');

  const overlay = document.createElement('div');
  overlay.id = 'clubSetupSheetOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)';
  overlay.innerHTML = `
    <div class="club-setup-sheet" id="clubSetupSheet">
      <div class="mode-sheet-handle"></div>
      <div class="mode-sheet-title">${modeLabel}</div>
      <p style="font-size:0.84rem;color:var(--text-dim);margin-bottom:16px;line-height:1.5">
        ${connectText}
      </p>

      <!-- TAB SWITCHER (hidden for organiser — join only) -->
      <div class="club-setup-tabs" id="clubSetupTabs" style="${targetMode === 'organiser' ? 'display:none' : ''}">
        <button class="club-setup-tab active" id="clubSetupTabJoin" onclick="_clubSetupShowTab('join')">${t('joinClub') || 'Join Club'}</button>
        <button class="club-setup-tab" id="clubSetupTabCreate" onclick="_clubSetupShowTab('create')">${t('createClub') || 'Create Club'}</button>
      </div>

      <!-- JOIN PANEL -->
      <div id="clubSetupPanelJoin" style="margin-top:14px">
        <input type="text" id="csJoinSearch" class="auth-input" placeholder="🔍 ${t('searchClubPlaceholder') || 'Search Club...'}" style="margin-bottom:6px" oninput="_clubSetupSearch(this.value)">
        <div id="csJoinResults" style="display:none;max-height:160px;overflow-y:auto;border-radius:10px;border:1px solid var(--border);margin-bottom:8px;background:var(--surface2)"></div>
        <div id="csJoinSelected" style="display:none;padding:8px 12px;border-radius:8px;background:rgba(108,99,255,0.1);border:1px solid rgba(108,99,255,0.3);margin-bottom:8px;font-size:0.85rem;color:var(--text)"></div>
        <input type="password" id="csJoinPassword" class="auth-input" placeholder="${joinPasswordPh}" style="margin-bottom:10px">
        <div id="csJoinFeedback" style="font-size:0.82rem;color:var(--red);min-height:18px;margin-bottom:10px"></div>
        <div style="display:flex;gap:10px">
          <button class="admin-modal-cancel" style="flex:1" onclick="document.getElementById('clubSetupSheetOverlay').remove()">${t('cancel') || 'Cancel'}</button>
          <button class="admin-modal-ok" style="flex:1" onclick="_clubSetupJoin()">${t('joinBtn') || 'Join'}</button>
        </div>
      </div>

      <!-- CREATE PANEL -->
      <div id="clubSetupPanelCreate" style="display:none;margin-top:14px">
        <div id="clubSetupPanelCreateForm">
          <input type="text"     id="csCreateName"    class="auth-input" placeholder="${t('clubNamePh')}"      style="margin-bottom:8px">
          <input type="password" id="csCreateAdminPw" class="auth-input" placeholder="${t('enterAdminPasswordPh')}"  style="margin-bottom:10px">
          <div id="csCreateFeedback" style="font-size:0.82rem;min-height:18px;margin-bottom:10px"></div>
          <div style="display:flex;gap:10px">
            <button class="admin-modal-cancel" style="flex:1" onclick="document.getElementById('clubSetupSheetOverlay').remove()">${t('cancel') || 'Cancel'}</button>
            <button class="admin-modal-ok" style="flex:1" onclick="_clubSetupCreateDirect()">${t('createClub') || 'Create Club'}</button>
          </div>
        </div>
      </div>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('clubSetupSheet').addEventListener('click', e => e.stopPropagation());

  // Load clubs for join dropdown
  _clubSetupLoadClubs();
}

function _clubSetupShowTab(tab) {
  document.getElementById('clubSetupTabJoin').classList.toggle('active', tab === 'join');
  document.getElementById('clubSetupTabCreate').classList.toggle('active', tab === 'create');
  document.getElementById('clubSetupPanelJoin').style.display   = tab === 'join'   ? '' : 'none';
  document.getElementById('clubSetupPanelCreate').style.display = tab === 'create' ? '' : 'none';
  // Reset create form
  if (tab === 'create') {
    _clubSetupCreateEmail = '';
  }
}

var _clubSetupSelectedId   = null;
var _clubSetupSelectedName = null;
var _clubSetupSearchTimer  = null;

function _clubSetupSearch(query) {
  var resultsEl = document.getElementById('csJoinResults');
  var selectedEl = document.getElementById('csJoinSelected');
  // Clear selection when user types again
  _clubSetupSelectedId = null;
  _clubSetupSelectedName = null;
  if (selectedEl) selectedEl.style.display = 'none';

  if (!query || query.trim().length < 2) {
    if (resultsEl) resultsEl.style.display = 'none';
    return;
  }
  if (resultsEl) {
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<div style="padding:10px 12px;font-size:0.82rem;color:var(--muted)">Searching...</div>';
  }
  clearTimeout(_clubSetupSearchTimer);
  _clubSetupSearchTimer = setTimeout(async function() {
    try {
      var rows = await sbGet('clubs', 'name=ilike.' + encodeURIComponent('%' + query.trim() + '%') + '&select=id,name&order=name.asc&limit=15');
      if (!rows || !rows.length) {
        if (resultsEl) resultsEl.innerHTML = '<div style="padding:10px 12px;font-size:0.82rem;color:var(--muted)">No clubs found</div>';
        return;
      }
      if (resultsEl) {
        resultsEl.innerHTML = rows.map(function(c) {
          return '<div onclick="_clubSetupSelectClub(\'' + c.id + '\',\'' + c.name.replace(/'/g,"\\'") + '\')" ' +
            'style="padding:10px 14px;cursor:pointer;font-size:0.88rem;color:var(--text);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">' +
            '<span style="font-size:1rem">🏢</span><span>' + c.name + '</span></div>';
        }).join('');
      }
    } catch(e) {
      if (resultsEl) resultsEl.innerHTML = '<div style="padding:10px 12px;font-size:0.82rem;color:var(--red)">Search failed</div>';
    }
  }, 350);
}

function _clubSetupSelectClub(id, name) {
  _clubSetupSelectedId   = id;
  _clubSetupSelectedName = name;
  var resultsEl  = document.getElementById('csJoinResults');
  var selectedEl = document.getElementById('csJoinSelected');
  var searchEl   = document.getElementById('csJoinSearch');
  if (resultsEl)  resultsEl.style.display = 'none';
  if (searchEl)   searchEl.value = name;
  if (selectedEl) { selectedEl.textContent = '✅ ' + name; selectedEl.style.display = 'block'; }
  // Focus password field
  var pw = document.getElementById('csJoinPassword');
  if (pw) pw.focus();
}

async function _clubSetupLoadClubs() {
  // No-op — replaced by search
}

async function _clubSetupJoin() {
  const pwInput = document.getElementById('csJoinPassword');
  const fb = document.getElementById('csJoinFeedback');
  const setFb = (msg, ok) => { if (fb) { fb.textContent = msg; fb.style.color = ok ? '#2dce89' : '#e63757'; } };

  if (!_clubSetupSelectedId) { setFb(t('pleaseSelectClubDot'), false); return; }
  const pw = pwInput ? pwInput.value.trim() : '';
  if (!pw) { setFb(t('enterClubPassword'), false); return; }

  setFb(t('checkingDot'), true);
  try {
    const encodedPw = encodeURIComponent(pw);
    const asAdmin = await sbGet('clubs', `id=eq.${_clubSetupSelectedId}&admin_password=eq.${encodedPw}&select=id,name`);
    const asUser  = await sbGet('clubs', `id=eq.${_clubSetupSelectedId}&select_password=eq.${encodedPw}&select=id,name`);

    if (!asAdmin.length && !asUser.length) throw new Error(t('wrongPasswordDot'));

    let role = asAdmin.length ? 'admin' : 'user';
    const clubs = asAdmin.length ? asAdmin : asUser;

    // Enforce mode-specific password rules before proceeding
    if (_clubSetupTargetMode === 'organiser' && role === 'admin') {
      throw new Error('Organiser requires the member password, not the admin password.');
    }
    if (_clubSetupTargetMode === 'vault' && role === 'user') {
      throw new Error('Vault requires the admin password, not the member password.');
    }

    await saveUserClubRole(clubs[0].id, _clubSetupTargetMode);

    if (typeof setMyClub === 'function') setMyClub(clubs[0].id, clubs[0].name);
    if (_clubSetupTargetMode === 'vault') {
      localStorage.setItem('kbrr_vault_club_id', clubs[0].id);
      localStorage.setItem('kbrr_vault_club_name', clubs[0].name || '');
    }
    if (_clubSetupTargetMode === 'organiser') {
      localStorage.setItem('kbrr_org_club_id', clubs[0].id);
      localStorage.setItem('kbrr_org_club_name', clubs[0].name || '');
    }
    localStorage.setItem('kbrr_club_mode', role);
    localStorage.setItem('kbrr_rating_field', 'club_rating');

    // Restore the selected workspace grant immediately
    // and redraw the Welcome tiles so their logout buttons are current
    // without requiring the manual Welcome refresh button.
    if (typeof restoreUserClubRoles === 'function') {
      await restoreUserClubRoles(typeof authGetUser === 'function' ? authGetUser() : null);
    }
    if (typeof updateWelcomeWorkspaceClubNames === 'function') {
      updateWelcomeWorkspaceClubNames();
    }

    if (pwInput) pwInput.value = '';

    setFb(role === 'admin' ? t('joinedAsAdmin') : t('joinedSuccessfully'), true);

    // Small delay so user sees success, then enter the mode
    setTimeout(() => {
      const ov = document.getElementById('clubSetupSheetOverlay');
      if (ov) ov.remove();
      if (typeof clubLoginRefresh === 'function') clubLoginRefresh();
      if (typeof syncToLocal === 'function') syncToLocal();

      const mode = _clubSetupTargetMode;
      if (mode === 'vault') {
        sessionStorage.setItem('scs_vault_verified', '1');
        localStorage.setItem('scs_vault_verified', '1');
        appMode = 'vault';
        sessionStorage.setItem('appMode', 'vault');
        localStorage.setItem('kbrr_app_mode', 'vault');
        applyMode('vault');
        updateModePill('vault');
        if (typeof showHomeScreen === 'function') showHomeScreen();
      } else if (mode === 'organiser') {
        // Organiser accepts user or admin password
        sessionStorage.setItem('scs_organiser_verified', '1');
        localStorage.setItem('scs_organiser_verified', '1');
        appMode = 'organiser';
        sessionStorage.setItem('appMode', 'organiser');
        localStorage.setItem('kbrr_app_mode', 'organiser');
        applyMode('organiser');
        updateModePill('organiser');
        if (typeof showHomeScreen === 'function') showHomeScreen();
      }
    }, 700);
  } catch(e) { setFb('❌ ' + e.message, false); }
}

async function _clubSetupCreateSendOtp() { _clubSetupCreateDirect(); } // legacy alias
async function _clubSetupCreateResend()  { } // no longer needed

async function _clubSetupCreateVerify() { _clubSetupCreateDirect(); } // legacy alias

async function _clubSetupCreateDirect() {
  const name    = document.getElementById('csCreateName')?.value.trim();
  const adminPw = document.getElementById('csCreateAdminPw')?.value.trim();
  const fb      = document.getElementById('csCreateFeedback');
  const setFb   = (msg, ok) => { if (fb) { fb.textContent = msg; fb.style.color = ok ? '#2dce89' : '#e63757'; } };

  if (!name)    { setFb(t('enterClubName'), false); return; }
  if (!adminPw) { setFb(t('enterAdminPw'), false); return; }

  setFb(t('creatingClubDot'), true);
  try {
    const club = await dbAddClub(name, null, adminPw);
    if (typeof setMyClub === 'function') setMyClub(club.id, club.name);
    if (_clubSetupTargetMode === 'vault') {
      localStorage.setItem('kbrr_vault_club_id', club.id);
      localStorage.setItem('kbrr_vault_club_name', club.name || '');
    }
    if (_clubSetupTargetMode === 'organiser') {
      localStorage.setItem('kbrr_org_club_id', club.id);
      localStorage.setItem('kbrr_org_club_name', club.name || '');
    }
    localStorage.setItem('kbrr_club_mode', 'admin');
    localStorage.setItem('kbrr_rating_field', 'club_rating');
    setFb('✅ ' + club.name + ' ' + t('clubCreatedAdmin'), true);
    await saveUserClubRole(club.id, _clubSetupTargetMode);

    // Keep the Welcome workspace cards synchronized immediately after a new
    // management club is created; do not wait for a manual refresh.
    if (typeof restoreUserClubRoles === 'function') {
      await restoreUserClubRoles(typeof authGetUser === 'function' ? authGetUser() : null);
    }
    if (typeof updateWelcomeWorkspaceClubNames === 'function') {
      updateWelcomeWorkspaceClubNames();
    }

    setTimeout(() => {
      const ov = document.getElementById('clubSetupSheetOverlay');
      if (ov) ov.remove();
      if (typeof clubLoginRefresh === 'function') clubLoginRefresh();
      if (typeof syncToLocal === 'function') syncToLocal();

      const mode = _clubSetupTargetMode;
      // Creator is always admin
      if (mode === 'vault') { sessionStorage.setItem('scs_vault_verified', '1'); localStorage.setItem('scs_vault_verified', '1'); }
      if (mode === 'organiser') { sessionStorage.setItem('scs_organiser_verified', '1'); localStorage.setItem('scs_organiser_verified', '1'); }
      appMode = mode;
      sessionStorage.setItem('appMode', mode);
      localStorage.setItem('kbrr_app_mode', mode);
      applyMode(mode);
      if (typeof showHomeScreen === 'function') showHomeScreen();
    }, 1000);
  } catch(e) { setFb('❌ ' + e.message, false); }
}

function _showVaultPasswordPrompt() {
  const existing = document.getElementById('vaultPromptOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'vaultPromptOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)';
  overlay.innerHTML = `
    <div class="vault-pw-sheet" id="vaultPwSheet">
      <div class="mode-sheet-handle"></div>
      <div class="mode-sheet-title">🔑 Vault Manager</div>
      <p style="font-size:0.84rem;color:var(--text-dim);margin-bottom:16px;line-height:1.5">
        Enter your club password (member or admin) to access Vault Manager.
      </p>
      <input type="password" id="vaultPwInput" class="admin-password-input"
             placeholder="${t('enterAdminPasswordPh')}"
             onkeydown="if(event.key==='Enter')verifyVaultPassword()"
             style="margin-bottom:12px;width:100%">
      <div id="vaultPwError" style="font-size:0.82rem;color:var(--red);min-height:18px;margin-bottom:12px"></div>
      <div style="display:flex;gap:10px">
        <button class="admin-modal-cancel" style="flex:1"
                onclick="document.getElementById('vaultPromptOverlay').remove()">Cancel</button>
        <button class="admin-modal-ok" style="flex:1"
                onclick="verifyVaultPassword()">Enter Vault</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('vaultPwSheet').addEventListener('click', e => e.stopPropagation());
  setTimeout(() => document.getElementById('vaultPwInput')?.focus(), 100);
}

async function verifyVaultPassword() {
  const input = document.getElementById('vaultPwInput');
  const errEl = document.getElementById('vaultPwError');
  const pw    = (input ? input.value : '').trim();
  if (!pw) { if (errEl) errEl.textContent = t('enterAdminPasswordHint'); return; }

  const club = (typeof getMyClub === 'function') ? getMyClub() : null;
  if (!club || !club.id) { if (errEl) errEl.textContent = t('noClubSelected'); return; }

  if (errEl) errEl.textContent = t('checkingDotDot');
  try {
    const adminRows = await sbGet('clubs', `id=eq.${club.id}&admin_password=eq.${encodeURIComponent(pw)}&select=id`);
    const userRows  = await sbGet('clubs', `id=eq.${club.id}&select_password=eq.${encodeURIComponent(pw)}&select=id`);
    if ((!adminRows || !adminRows.length) && (!userRows || !userRows.length)) {
      if (errEl) errEl.textContent = t('wrongAdminPw');
      if (input) input.value = '';
      return;
    }
    const role = (adminRows && adminRows.length) ? 'admin' : 'user';
    localStorage.setItem('kbrr_club_mode', role);
    await saveUserClubRole(club.id, 'vault');
    const ov = document.getElementById('vaultPromptOverlay');
    if (ov) ov.remove();
    localStorage.setItem('scs_vault_verified', '1');
    switchMode('vault');
  } catch(e) {
    if (errEl) errEl.textContent = t('errorPrefix') + e.message;
  }
}

/* =============================================================
   POWER BUTTON -- End Session
============================================================= */
async function endSession(fromProfile = false) {
  // Show shuttle cost sheet instead of plain confirm
  showShuttleSheet();
}

function showShuttleSheet() {
  const existing = document.getElementById('shuttleSheetOverlay');
  if (existing) existing.remove();

  const playerCount = (typeof schedulerState !== 'undefined') ? schedulerState.allPlayers.length : 0;

  const overlay = document.createElement('div');
  overlay.id = 'shuttleSheetOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:flex-end;';
  overlay.innerHTML = `
    <div class="shuttle-sheet" id="shuttleSheet">
      <div class="shuttle-handle"></div>
      <div class="shuttle-title">💰 ${t('sessionCost')}</div>

      <div class="shuttle-mode-toggle">
        <button class="shuttle-mode-btn active" id="shuttleModeA" onclick="shuttleSwitchMode('itemized')">📋 ${t('itemized')}</button>
        <button class="shuttle-mode-btn" id="shuttleModeB" onclick="shuttleSwitchMode('flat')">💴 ${t('flatFee')}</button>
      </div>

      <!-- Itemized mode -->
      <div id="shuttleModeItemized">
        <div class="shuttle-2col">
          <div class="shuttle-input-group">
            <div class="shuttle-input-label">🪶 ${t('pricePerTube')}</div>
            <input type="number" id="shuttleTubePrice" class="shuttle-input" placeholder="e.g. 6000" oninput="shuttleCalc()">
          </div>
          <div class="shuttle-input-group">
            <div class="shuttle-input-label">🏸 ${t('shuttlesUsed')}</div>
            <input type="number" id="shuttleCount" class="shuttle-input" placeholder="e.g. 16" oninput="shuttleCalc()">
          </div>
        </div>
        <div class="shuttle-divider"><div class="shuttle-div-line"></div><span class="shuttle-div-txt">${t('optional')}</span><div class="shuttle-div-line"></div></div>
        <div class="shuttle-input-group">
          <div class="shuttle-input-label">🏟 ${t('courtFeeTotal')}</div>
          <input type="number" id="shuttleCourtFee" class="shuttle-input" placeholder="¥0" oninput="shuttleCalc()">
        </div>
        <div class="shuttle-input-group" style="margin-top:8px">
          <div class="shuttle-input-label">📦 ${t('miscFeeTotal')}</div>
          <input type="number" id="shuttleMiscFee" class="shuttle-input" placeholder="¥0" oninput="shuttleCalc()">
        </div>
      </div>

      <!-- Flat fee mode -->
      <div id="shuttleModeFlat" style="display:none">
        <div class="shuttle-input-group" style="margin-top:4px">
          <div class="shuttle-input-label">💴 ${t('amountPerPlayer')}</div>
          <input type="number" id="shuttleFlatFee" class="shuttle-input shuttle-input-lg" placeholder="¥0" oninput="shuttleCalc()">
        </div>
      </div>

      <!-- Calc result -->
      <div class="shuttle-calc-box" id="shuttleCalcBox" style="display:none">
        <div class="shuttle-calc-row" id="shuttleCalcShuttles" style="display:none">
          <span class="shuttle-calc-label">🪶 ${t('shuttlesLabel')}</span>
          <span class="shuttle-calc-val" id="shuttleCostShuttles">--</span>
        </div>
        <div class="shuttle-calc-row" id="shuttleCalcCourt" style="display:none">
          <span class="shuttle-calc-label">🏟 ${t('courtLabel')}</span>
          <span class="shuttle-calc-val" id="shuttleCostCourt">--</span>
        </div>
        <div class="shuttle-calc-row" id="shuttleCalcMisc" style="display:none">
          <span class="shuttle-calc-label">📦 ${t('miscLabel')}</span>
          <span class="shuttle-calc-val" id="shuttleCostMisc">--</span>
        </div>
        <div class="shuttle-calc-row shuttle-calc-total">
          <span class="shuttle-calc-label">${t('perPlayerLabel')} (${playerCount})</span>
          <span class="shuttle-calc-val shuttle-calc-big" id="shuttleCostPerPlayer">--</span>
        </div>
      </div>

      <button onclick="confirmEndSession()"
        style="width:100%;padding:15px;background:linear-gradient(135deg,#e63757,#c42444);color:#fff;border:none;border-radius:14px;font-size:1rem;font-weight:800;cursor:pointer;font-family:inherit;margin-top:10px;letter-spacing:0.02em;box-shadow:0 4px 16px rgba(230,55,87,0.35);">
        ⏹ ${t('endSession')}
      </button>
      <button onclick="skipShuttleAndEnd()"
        style="width:100%;padding:10px;background:none;border:none;color:var(--muted,#888);font-size:0.8rem;cursor:pointer;font-family:inherit;margin-top:4px;opacity:0.7;">
        ${t('skipEndWithoutCost')}
      </button>
    </div>`;

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('shuttleSheet').addEventListener('click', e => e.stopPropagation());
}

function shuttleSwitchMode(mode) {
  const isItemized = mode === 'itemized';
  document.getElementById('shuttleModeItemized').style.display = isItemized ? '' : 'none';
  document.getElementById('shuttleModeFlat').style.display     = isItemized ? 'none' : '';
  document.getElementById('shuttleModeA').classList.toggle('active', isItemized);
  document.getElementById('shuttleModeB').classList.toggle('active', !isItemized);
  document.getElementById('shuttleCalcBox').style.display = 'none';
}

function shuttleCalc() {
  const players = (typeof schedulerState !== 'undefined') ? schedulerState.allPlayers.length : 0;
  const isFlat  = document.getElementById('shuttleModeFlat')?.style.display !== 'none';

  if (isFlat) {
    const flat = parseFloat(document.getElementById('shuttleFlatFee')?.value) || 0;
    if (!flat) { document.getElementById('shuttleCalcBox').style.display = 'none'; return; }
    document.getElementById('shuttleCalcBox').style.display = '';
    document.getElementById('shuttleCalcShuttles').style.display = 'none';
    document.getElementById('shuttleCalcCourt').style.display    = 'none';
    document.getElementById('shuttleCalcMisc').style.display     = 'none';
    document.getElementById('shuttleCostPerPlayer').textContent  = '¥' + Math.round(flat).toLocaleString();
    return;
  }

  // Itemized
  const tubePrice  = parseFloat(document.getElementById('shuttleTubePrice')?.value) || 0;
  const count      = parseFloat(document.getElementById('shuttleCount')?.value) || 0;
  const courtFee   = parseFloat(document.getElementById('shuttleCourtFee')?.value) || 0;
  const miscFee    = parseFloat(document.getElementById('shuttleMiscFee')?.value) || 0;

  const shuttleCost = tubePrice && count ? (tubePrice / 12) * count : 0;
  const total       = shuttleCost + courtFee + miscFee;
  const perPlayer   = players > 0 ? total / players : 0;

  if (!total) { document.getElementById('shuttleCalcBox').style.display = 'none'; return; }

  document.getElementById('shuttleCalcBox').style.display = '';

  const showRow = (rowId, valId, val) => {
    document.getElementById(rowId).style.display = val > 0 ? '' : 'none';
    if (val > 0) document.getElementById(valId).textContent = '¥' + Math.round(val / players).toLocaleString() + '/player';
  };
  showRow('shuttleCalcShuttles', 'shuttleCostShuttles', shuttleCost);
  showRow('shuttleCalcCourt',    'shuttleCostCourt',    courtFee);
  showRow('shuttleCalcMisc',     'shuttleCostMisc',     miscFee);
  document.getElementById('shuttleCostPerPlayer').textContent = '¥' + Math.round(perPlayer).toLocaleString();
}

async function confirmEndSession() {
  const players  = (typeof schedulerState !== 'undefined') ? schedulerState.allPlayers.length : 0;
  const isFlat   = document.getElementById('shuttleModeFlat')?.style.display !== 'none';
  let shuttleData = null;

  if (isFlat) {
    const flat = parseFloat(document.getElementById('shuttleFlatFee')?.value) || 0;
    if (flat) shuttleData = { mode: 'flat', cost_per_player: Math.round(flat), player_count: players };
  } else {
    const tubePrice = parseFloat(document.getElementById('shuttleTubePrice')?.value) || 0;
    const count     = parseFloat(document.getElementById('shuttleCount')?.value) || 0;
    const courtFee  = parseFloat(document.getElementById('shuttleCourtFee')?.value) || 0;
    const miscFee   = parseFloat(document.getElementById('shuttleMiscFee')?.value) || 0;
    const shuttleCost = tubePrice && count ? (tubePrice / 12) * count : 0;
    const total       = shuttleCost + courtFee + miscFee;
    const perPlayer   = players > 0 ? Math.round(total / players) : 0;
    if (total) shuttleData = {
      mode: 'itemized',
      tube_price: tubePrice, shuttles_used: count,
      court_fee: courtFee,   misc_fee: miscFee,
      total_cost: Math.round(total),
      cost_per_player: perPlayer,
      player_count: players
    };
  }

  document.getElementById('shuttleSheetOverlay')?.remove();
  await _doEndSession(shuttleData);
}

/* ── Edit Session Cost (organiser only) ── */
function showEditCostSheet(sessionId, existingData, sessionPlayers) {
  const existing = document.getElementById('editCostOverlay');
  if (existing) existing.remove();

  const isFlat    = !existingData || existingData.mode === 'flat';
  const flatVal   = existingData?.cost_per_player || '';
  const tubePrice = existingData?.tube_price       || '';
  const shuttles  = existingData?.shuttles_used    || '';
  const courtFee  = existingData?.court_fee        || '';
  const miscFee   = existingData?.misc_fee         || '';
  const players   = (sessionPlayers && sessionPlayers.length) ? sessionPlayers.length : (existingData?.player_count || 0);

  const overlay = document.createElement('div');
  overlay.id = 'editCostOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:flex-end;';
  overlay.innerHTML = `
    <div class="shuttle-sheet" id="editCostSheet">
      <div class="shuttle-handle"></div>
      <div class="shuttle-title">✏️ ${t('editSessionCost')}</div>
      <div class="shuttle-mode-toggle">
        <button class="shuttle-mode-btn ${isFlat?'':'active'}" id="editModeA" onclick="editCostSwitchMode('itemized')">📋 ${t('itemized')}</button>
        <button class="shuttle-mode-btn ${isFlat?'active':''}" id="editModeB" onclick="editCostSwitchMode('flat')">💴 ${t('flatFee')}</button>
      </div>
      <div id="editModeItemized" style="${isFlat?'display:none':''}">
        <div class="shuttle-2col">
          <div class="shuttle-input-group">
            <div class="shuttle-input-label">🪶 ${t('pricePerTube')}</div>
            <input type="number" id="editTubePrice" class="shuttle-input" value="${tubePrice}" placeholder="e.g. 6000" oninput="editCostCalc()">
          </div>
          <div class="shuttle-input-group">
            <div class="shuttle-input-label">🏸 ${t('shuttlesUsed')}</div>
            <input type="number" id="editShuttleCount" class="shuttle-input" value="${shuttles}" placeholder="e.g. 16" oninput="editCostCalc()">
          </div>
        </div>
        <div class="shuttle-input-group">
          <div class="shuttle-input-label">🏟 ${t('courtFeeTotal')}</div>
          <input type="number" id="editCourtFee" class="shuttle-input" value="${courtFee}" placeholder="¥0" oninput="editCostCalc()">
        </div>
        <div class="shuttle-input-group" style="margin-top:8px">
          <div class="shuttle-input-label">📦 ${t('miscFeeTotal')}</div>
          <input type="number" id="editMiscFee" class="shuttle-input" value="${miscFee}" placeholder="¥0" oninput="editCostCalc()">
        </div>
      </div>
      <div id="editModeFlat" style="${isFlat?'':'display:none'}">
        <div class="shuttle-input-group">
          <div class="shuttle-input-label">💴 ${t('amountPerPlayer')}</div>
          <input type="number" id="editFlatFee" class="shuttle-input shuttle-input-lg" value="${flatVal}" placeholder="¥0" oninput="editCostCalc()">
        </div>
      </div>
      <div class="shuttle-result" id="editCostResult"></div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button onclick="document.getElementById('editCostOverlay').remove()"
          style="flex:1;padding:14px;background:none;border:2px solid var(--border,#444);color:var(--text,#fff);border-radius:14px;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit;">
          ${t('cancel')}
        </button>
        <button onclick="saveEditedCost('${sessionId}', _editCostPlayers)"
          style="flex:2;padding:14px;background:linear-gradient(135deg,#6c63ff,#574fd6);color:#fff;border:none;border-radius:14px;font-size:1rem;font-weight:800;cursor:pointer;font-family:inherit;">
          💾 ${t('save')}
        </button>
      </div>
    </div>`;

  window._editCostPlayers = sessionPlayers || [];
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  editCostCalc();
}

function editCostSwitchMode(mode) {
  document.getElementById('editModeItemized').style.display = mode === 'itemized' ? '' : 'none';
  document.getElementById('editModeFlat').style.display     = mode === 'flat'     ? '' : 'none';
  document.getElementById('editModeA').classList.toggle('active', mode === 'itemized');
  document.getElementById('editModeB').classList.toggle('active', mode === 'flat');
  editCostCalc();
}

function editCostCalc() {
  const isFlat  = document.getElementById('editModeFlat')?.style.display !== 'none';
  const result  = document.getElementById('editCostResult');
  if (!result) return;
  if (isFlat) {
    const flat = parseFloat(document.getElementById('editFlatFee')?.value) || 0;
    result.innerHTML = flat ? `<span class="shuttle-per-player">¥${Math.round(flat).toLocaleString()} / player</span>` : '';
  } else {
    const tubePrice = parseFloat(document.getElementById('editTubePrice')?.value)    || 0;
    const count     = parseFloat(document.getElementById('editShuttleCount')?.value) || 0;
    const courtFee  = parseFloat(document.getElementById('editCourtFee')?.value)     || 0;
    const miscFee   = parseFloat(document.getElementById('editMiscFee')?.value)      || 0;
    const shuttle   = tubePrice && count ? (tubePrice / 12) * count : 0;
    const total     = shuttle + courtFee + miscFee;
    const pc        = window._editCostPlayers ? window._editCostPlayers.length : 0;
    const perPlayer = pc > 0 ? Math.round(total / pc) : 0;
    if (total) {
      result.innerHTML = `<span class="shuttle-per-player">Total ¥${Math.round(total).toLocaleString()}${pc ? ' · ¥' + perPlayer.toLocaleString() + '/player' : ''}</span>`;
    }
  }
}

async function saveEditedCost(sessionId, sessionPlayers) {
  const playerCount = Array.isArray(sessionPlayers) ? sessionPlayers.length : (sessionPlayers || 0);
  const isFlat = document.getElementById('editModeFlat')?.style.display !== 'none';
  let shuttleData = null;

  if (isFlat) {
    const flat = parseFloat(document.getElementById('editFlatFee')?.value) || 0;
    if (flat) shuttleData = { mode: 'flat', cost_per_player: Math.round(flat), player_count: playerCount };
  } else {
    const tubePrice = parseFloat(document.getElementById('editTubePrice')?.value)    || 0;
    const count     = parseFloat(document.getElementById('editShuttleCount')?.value) || 0;
    const courtFee  = parseFloat(document.getElementById('editCourtFee')?.value)     || 0;
    const miscFee   = parseFloat(document.getElementById('editMiscFee')?.value)      || 0;
    const shuttle   = tubePrice && count ? (tubePrice / 12) * count : 0;
    const total     = shuttle + courtFee + miscFee;
    const perPlayer = playerCount > 0 ? Math.round(total / playerCount) : 0;
    if (total) shuttleData = {
      mode: 'itemized', tube_price: tubePrice, shuttles_used: count,
      court_fee: courtFee, misc_fee: miscFee,
      total_cost: Math.round(total), cost_per_player: perPlayer, player_count: playerCount
    };
  }

  if (!shuttleData) { alert('Please enter cost details'); return; }

  try {
    // 1. Update sessions.shuttle_data
    await sbPatch('sessions', `id=eq.${sessionId}`, { shuttle_data: shuttleData });

    // 2. Update players.sessions[].cost_per_player matched by session_id
    const club = (typeof getMyClub === 'function') ? getMyClub() : null;
    if (club && club.id && Array.isArray(sessionPlayers) && sessionPlayers.length) {
      for (const p of sessionPlayers) {
        const name = p.name || p.player_name || '';
        if (!name) continue;
        try {
          const mrows = await sbGet('memberships',
            `club_id=eq.${club.id}&nickname=ilike.${encodeURIComponent(name)}&select=player_id`
          ).catch(() => []);
          if (!mrows || !mrows.length) continue;
          const prows = await sbGet('players',
            `id=eq.${mrows[0].player_id}&select=id,sessions`
          ).catch(() => []);
          if (!prows || !prows.length) continue;
          const existing = prows[0].sessions || [];
          // Match by session_id (new entries) — reliable even with multiple sessions per day
          const updated = existing.map(entry =>
            entry.session_id === sessionId
              ? { ...entry, cost_per_player: shuttleData.cost_per_player }
              : entry
          );
          // Only patch if something changed
          if (JSON.stringify(updated) !== JSON.stringify(existing)) {
            await sbPatch('players', `id=eq.${prows[0].id}`, { sessions: updated }).catch(() => {});
          }
        } catch(e) { /* silent per player */ }
      }
    }

    document.getElementById('editCostOverlay')?.remove();
    if (typeof renderDashboard === 'function') renderDashboard();
    _qcToast('✅ Cost updated — ¥' + shuttleData.cost_per_player.toLocaleString() + '/player');
  } catch(e) {
    alert('Failed to save: ' + e.message);
  }
}

async function skipShuttleAndEnd() {
  document.getElementById('shuttleSheetOverlay')?.remove();
  await _doEndSession(null);
}

async function _doEndSession(shuttleData) {
  // Show ending feedback
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;color:#fff;padding:16px 24px;border-radius:14px;font-size:0.9rem;font-weight:700;z-index:99999;text-align:center;';
  toast.textContent = t('endingSession');
  document.body.appendChild(toast);

  // Mark session completed in sessions table
  if (typeof dbCompleteSession === 'function') await dbCompleteSession(shuttleData);

  // Flush live_sessions → players.sessions, then delete temp rows
  if (typeof flushLiveSession === 'function') await flushLiveSession();

  // Release session slots
  if (typeof dbReleaseMySession === 'function') await dbReleaseMySession();

  // Clear local session state -- no reload
  localStorage.removeItem('schedulerState');
  localStorage.removeItem('allRounds');
  localStorage.removeItem('currentRoundIndex');
  sessionStorage.removeItem('kbrr_session_db_id');

  // Reset in-memory state
  if (typeof allRounds !== 'undefined') allRounds.length = 0;
  if (typeof schedulerState !== 'undefined') {
    schedulerState.activeplayers = [];
    schedulerState.allPlayers    = [];
    if (schedulerState.winCount)    schedulerState.winCount.clear();
    if (schedulerState.PlayedCount) schedulerState.PlayedCount.clear();
    if (schedulerState.restCount)   schedulerState.restCount.clear();
    schedulerState.mbmActive  = false;
    schedulerState.fixedPairs = [];
    schedulerState.fixedPairGameQueue     = null;
    schedulerState.fixedPairGameQueueHash = null;
    if (typeof clearFixedPairsUI        === 'function') clearFixedPairsUI();
    if (typeof updateFixedPairSelectors  === 'function') updateFixedPairSelectors();
  }

  // Stop heartbeat
  if (typeof stopSessionHeartbeat === 'function') stopSessionHeartbeat();

  // Reset round state machine
  if (typeof currentState !== 'undefined') currentState = 'idle';
  if (typeof roundActive  !== 'undefined') roundActive  = false;
  if (typeof sessionFinished !== 'undefined') sessionFinished = false;

  // Reset Next/Play button appearance
  const nextBtn  = document.getElementById('nextBtn');
  const btnText  = document.getElementById('btnText');
  const btnIcon  = nextBtn ? nextBtn.querySelector('.icon') : null;
  if (nextBtn)  { nextBtn.classList.add('start-state'); nextBtn.classList.remove('round-active','end'); }
  if (btnText)  { btnText.textContent = t('startGame') || 'Play'; }
  if (btnIcon)  { btnIcon.textContent = ' ▶'; }

  // Re-enable all disabled buttons
  document.querySelectorAll('.disabled').forEach(el => {
    el.style.pointerEvents = '';
    el.classList.remove('disabled');
  });

  // Hide live bar
  updateSessionLiveBar();

  // Remove toast
  toast.textContent = t('sessionEnded');
  setTimeout(() => toast.remove(), 1500);

  // Clear saved snapshot — session is done
  if (typeof clearSnapshot === 'function') clearSnapshot();

  // Reset organiser stepper to step 1
  if (typeof _stepCourtsSet   !== 'undefined') _stepCourtsSet   = false;
  if (typeof _stepPairsSeen   !== 'undefined') _stepPairsSeen   = false;
  if (typeof _homeCurrentStep !== 'undefined') _homeCurrentStep = 0;

  // Clear player list UI
  if (typeof updatePlayerList === 'function') updatePlayerList();

  // Go home — showHomeScreen calls homeUpdateStepper which shows step 1
  if (typeof showHomeScreen === 'function') {
    showHomeScreen();
  }
}

/* === SETTINGS TAB SWITCHER === */
function settingsShowTab(tab) {
  ["club","general"].forEach(t => {
    const el = document.getElementById("settingsTab" + t.charAt(0).toUpperCase() + t.slice(1));
    if (el) el.style.display = t === tab ? "" : "none";
    const btn = document.getElementById("settingsTab" + t.charAt(0).toUpperCase() + t.slice(1) + "Btn");
    if (btn) btn.classList.toggle("active", t === tab);
  });
}

// Close fixed pair picker on outside click
document.addEventListener("click", function(e) {
  if (typeof fpOpenPicker !== "undefined" && fpOpenPicker !== null) {
    if (!e.target.closest(".fp-picker-field") && !e.target.closest(".fp-dropdown")) {
      fpClosePicker(fpOpenPicker);
    }
  }
});


/* ── Tile Style System ── */
function setTileStyle(style) {
  // Apply tile style to the whole app (body class) and save
  document.body.classList.remove('tile-style-glow','tile-style-color');
  if (style === 'glow')  document.body.classList.add('tile-style-glow');
  if (style === 'color') document.body.classList.add('tile-style-color');
  localStorage.setItem('kbrr_tile_style', style);

  // Sync tile style buttons active state
  ['flat','glow','color'].forEach(function(s, i) {
    var btn = document.getElementById('styleBtn'+(i+1));
    if (btn) btn.classList.toggle('active', s === style);
  });
}

function loadHomeStyle() {
  var style = localStorage.getItem('kbrr_tile_style') || 'flat';
  setTileStyle(style);
}


// Verify again whenever the installed PWA returns from the background.
// This catches a login takeover even when the two-minute poll was paused by iOS/Android.
document.addEventListener('visibilitychange', async function() {
  if (document.visibilityState !== 'visible') return;
  if (typeof authIsLoggedIn !== 'function' || !authIsLoggedIn()) return;
  if (typeof authVerifySession === 'function') {
    var validSession = await authVerifySession();
    if (!validSession) return;
  }
  if (typeof _startSessionWatch === 'function') _startSessionWatch();
});


/* Build 356 — swipe/keyboard support for the rotational Welcome carousel. */
(function initWelcomeWorkspaceCarousel() {
  function setup() {
    var carousel = document.getElementById('welcomeWorkspaceCarousel');
    if (!carousel || carousel.dataset.carouselReady === '1') return;
    carousel.dataset.carouselReady = '1';
    var modes = ['viewer', 'organiser', 'vault'];
    var touchStartX = null;

    function rotate(direction) {
      var current = modes.indexOf(welcomeSelectedWorkspace);
      if (current < 0) current = 0;
      var next = (current + direction + modes.length) % modes.length;
      welcomeCycleWorkspace(direction);
      var selected = carousel.querySelector('.welcome-workspace.active');
      if (selected) selected.focus({ preventScroll: true });
    }

    carousel.addEventListener('keydown', function(event) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); rotate(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); rotate(1); }
    });
    carousel.addEventListener('touchstart', function(event) {
      touchStartX = event.changedTouches && event.changedTouches[0] ? event.changedTouches[0].clientX : null;
    }, { passive: true });
    carousel.addEventListener('touchend', function(event) {
      if (touchStartX === null || !event.changedTouches || !event.changedTouches[0]) return;
      var distance = event.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(distance) < 38) return;
      rotate(distance < 0 ? 1 : -1);
    }, { passive: true });

    welcomeSelectWorkspace(welcomeSelectedWorkspace || 'viewer');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();

/* Build 358 — Guided Functions: independent, one-time helper for each module. */
var _scsGuideRole = '';
var _scsGuideCurrentStep = null;
var _scsGuideChildPageId = '';
var _scsGuideConfig = {
  viewer: {
    accent:'#2767e8', icon:'🏸', title:'Let’s set you up as a Player',
    subtitle:'A few guided actions will get you ready to join and play.',
    note:'This helper appears only for an incomplete Player module. It will not change another module.',
    steps:[
      {id:'nickname', title:'Nickname', desc:'Choose the name other players will see.'},
      {id:'gender', title:'Gender', desc:'Set your player gender for eligible slots.'},
      {id:'club', title:'Join a Club', desc:'Find your club and send a join request.'}
    ]
  },
  vault: {
    accent:'#20934b', icon:'🏢', title:'Let’s set up Club Manager',
    subtitle:'Create the club, add its players and publish the first slot.',
    note:'Each completed action is detected automatically. Existing Club Manager users continue normally.',
    steps:[
      {id:'club', title:'Create Club', desc:'Create and connect your club.'},
      {id:'players', title:'Add Players', desc:'Register or import players into the club.'},
      {id:'slot', title:'Slot Creation', desc:'Create and publish the club’s first slot.'}
    ]
  },
  organiser: {
    accent:'#6937d5', icon:'📅', title:'Let’s set up Organiser',
    subtitle:'Prepare the players, then start the correct available session.',
    note:'A slot can start only when it becomes available 15 minutes before its scheduled time. The helper does not alter that rule.',
    steps:[
      {id:'club', title:'Join or Create a Club', desc:'Use a club you joined, or create one through Club Manager.'},
      {id:'players', title:'Prepare Players', desc:'Use players from the available slot or add players for the round.'},
      {id:'round', title:'Start Round', desc:'Open the due slot and start when the existing 15-minute rule enables it.'}
    ]
  }
};
function _scsGuideKey(role){ return 'scs_guided_functions_'+role; }
function _scsGuideHasPlayerName(){ var u=typeof authGetUser==='function'?authGetUser():null,p=typeof getMyPlayer==='function'?getMyPlayer():null;return !!((u&&(u.nickname||u.displayName))||(p&&(p.name||p.displayName||p.nickname))); }
function _scsGuideNormaliseGender(value){
  var g=String(value||'').trim().toLowerCase();
  if(g==='male'||g==='m'||g==='man'||g==='boy') return 'Male';
  if(g==='female'||g==='f'||g==='woman'||g==='girl') return 'Female';
  return '';
}
function _scsGuideHasGender(){
  var u=typeof authGetUser==='function'?authGetUser():null;
  var p=typeof getMyPlayer==='function'?getMyPlayer():null;
  var gender=_scsGuideNormaliseGender((u&&u.gender)||(p&&p.gender)||localStorage.getItem('scs_player_gender'));
  if(!gender) return false;

  // The logged-in account/profile is the source of truth. Keep the old
  // confirmation keys in sync so existing helper logic also recognises it.
  localStorage.setItem('scs_player_gender',gender);
  localStorage.setItem('scs_player_gender_confirmed','1');
  try{
    if(u){
      u.gender=gender;
      u.genderConfirmed=true;
      localStorage.setItem('auth_user',JSON.stringify(u));
    }
  }catch(e){}
  try{
    if(typeof setMyPlayer==='function'){
      setMyPlayer({name:(p&&p.name)||((u&&(u.nickname||u.displayName))||''),gender:gender});
    }
  }catch(e){}
  return true;
}
function _scsGuideHasClub(){ var c=typeof getMyClub==='function'?getMyClub():null;return !!(c&&c.id); }
function _scsGuideHasPlayers(){ return !!(window.schedulerState&&Array.isArray(schedulerState.allPlayers)&&schedulerState.allPlayers.length); }
function _scsGuideSelectedPlayerCount(){
  if(!window.schedulerState)return 0;
  if(Array.isArray(schedulerState.activeplayers)&&schedulerState.activeplayers.length)return schedulerState.activeplayers.length;
  if(Array.isArray(schedulerState.allPlayers))return schedulerState.allPlayers.filter(function(player){return player&&player.active;}).length;
  return 0;
}
function _scsGuideHasEnoughPlayers(){return _scsGuideSelectedPlayerCount()>=4;}
function _scsGuideRestoreSelectedPlayers(){
  if(!window.schedulerState||!Array.isArray(schedulerState.allPlayers)||!schedulerState.activeplayers)return;

  var currentActive=Array.from(schedulerState.activeplayers||[]).map(function(name){return String(name||'').trim();}).filter(Boolean);
  var sourcePlayers=[];
  var sourceActive=[];

  // Assist can open before normal Organiser entry restores the current
  // session. Restore only its player slice, without changing rounds.
  if(!schedulerState.allPlayers.length||!currentActive.length){
    try{
      var snapshot=JSON.parse(localStorage.getItem('kbrr_snapshot')||'null');
      var savedState=snapshot&&snapshot.schedulerState;
      if(savedState&&Array.isArray(savedState.allPlayers)){
        sourcePlayers=savedState.allPlayers;
        sourceActive=Array.isArray(savedState.activeplayers)?savedState.activeplayers:[];
      }
    }catch(e){}
  }
  if(!sourcePlayers.length&&!schedulerState.allPlayers.length){
    try{
      var cached=JSON.parse(localStorage.getItem('schedulerPlayers')||'[]');
      if(Array.isArray(cached)){
        sourcePlayers=cached;
        sourceActive=cached.filter(function(player){return player&&player.active;}).map(function(player){return player.name;});
      }
    }catch(e){}
  }

  if(sourcePlayers.length&&!schedulerState.allPlayers.length){
    schedulerState.allPlayers.splice(0,schedulerState.allPlayers.length,...sourcePlayers.map(function(player){
      return Object.assign({},player);
    }));
  }
  if(sourceActive.length&&!currentActive.length){
    var activeKeys=new Set(sourceActive.map(function(name){return String(name||'').trim().toLowerCase();}).filter(Boolean));
    schedulerState.allPlayers.forEach(function(player){
      if(player&&player.name)player.active=activeKeys.has(String(player.name).trim().toLowerCase());
    });
    schedulerState.activeplayers.splice(
      0,
      schedulerState.activeplayers.length,
      ...schedulerState.allPlayers.filter(function(player){return player&&player.active;}).map(function(player){return player.name;}).reverse()
    );
  }

  // Repair a partial state where active names exist before player objects.
  var known=new Set(schedulerState.allPlayers.map(function(player){return String((player&&player.name)||'').trim().toLowerCase();}));
  var history=[];
  try{history=JSON.parse(localStorage.getItem('newImportHistory')||'[]');}catch(e){}
  Array.from(schedulerState.activeplayers||[]).forEach(function(name){
    var key=String(name||'').trim().toLowerCase();
    if(!key||known.has(key))return;
    var record=Array.isArray(history)?history.find(function(player){
      return String((player&&(player.displayName||player.name))||'').trim().toLowerCase()===key;
    }):null;
    schedulerState.allPlayers.push({
      name:String(name).trim(),
      gender:(record&&record.gender)||'Male',
      rating:(record&&(record.activeRating||record.rating))||1,
      activeRating:(record&&(record.activeRating||record.rating))||1,
      active:true
    });
    known.add(key);
  });
}
function _scsGuideStepDone(role,id){
  if(role==='viewer'){
    if(id==='joined') return typeof authIsLoggedIn==='function'&&authIsLoggedIn();
    if(id==='nickname') return _scsGuideHasPlayerName();
    if(id==='gender') return _scsGuideHasGender();
    if(id==='club') return _scsGuideHasClub();
  }
  if(role==='vault'){
    if(id==='club') return _scsGuideHasClub()||hasVerifiedWorkspaceRole('vault');
    if(id==='players') return _scsGuideHasPlayers();
    if(id==='slot') return false;
  }
  if(role==='organiser'){
    if(id==='club') return _scsGuideHasClub()||hasVerifiedWorkspaceRole('organiser');
    if(id==='players') return _scsGuideHasEnoughPlayers();
    if(id==='round') return false;
  }
  return false;
}

function scsGuideAskGender(){
  var old=document.getElementById('scsGuideGenderModal'); if(old)old.remove();
  var modal=document.createElement('div'); modal.id='scsGuideGenderModal'; modal.className='scs-guide-gender-modal';
  modal.innerHTML='<div class="scs-guide-gender-card"><button class="scs-guide-gender-close scs-popup-close-btn" type="button" aria-label="Close">×</button><div class="scs-guide-gender-icon">🏸</div><h3>Select your gender</h3><p>This helps SCS show the correct eligible slots.</p><div class="scs-guide-gender-actions"><button type="button" data-gender="Male">♂ Male</button><button type="button" data-gender="Female">♀ Female</button></div></div>';
  document.body.appendChild(modal);
  function close(){modal.remove();}
  modal.querySelector('.scs-guide-gender-close').onclick=close;
  modal.addEventListener('click',function(e){if(e.target===modal)close();});
  modal.querySelectorAll('[data-gender]').forEach(function(btn){btn.onclick=function(){
    var gender=btn.getAttribute('data-gender');
    localStorage.setItem('scs_player_gender',gender); localStorage.setItem('scs_player_gender_confirmed','1');
    try{var u=typeof authGetUser==='function'?authGetUser():null;if(u){u.gender=gender;u.genderConfirmed=true;localStorage.setItem('auth_user',JSON.stringify(u));}}catch(e){}
    try{var p=typeof getMyPlayer==='function'?getMyPlayer():null;if(typeof setMyPlayer==='function')setMyPlayer({name:(p&&p.name)||(_scsGuideHasPlayerName()&&((authGetUser()||{}).nickname))||'',gender:gender});}catch(e){}
    close(); setTimeout(function(){scsOpenGuidedFunctions('viewer');},120);
  };});
}

function scsMigrateExistingGuides(){
  if(localStorage.getItem('scs_guided_functions_migrated_357')) return;
  if((typeof authIsLoggedIn==='function'&&authIsLoggedIn()) && _scsGuideHasPlayerName() && _scsGuideHasGender() && _scsGuideHasClub()) localStorage.setItem(_scsGuideKey('viewer'),'complete');
  if(typeof hasVerifiedWorkspaceRole==='function'&&hasVerifiedWorkspaceRole('organiser')) localStorage.setItem(_scsGuideKey('organiser'),'complete');
  if(typeof hasVerifiedWorkspaceRole==='function'&&hasVerifiedWorkspaceRole('vault')) localStorage.setItem(_scsGuideKey('vault'),'complete');
  localStorage.setItem('scs_guided_functions_migrated_357','1');
}
function scsMaybeShowGuidedFunctions(role){
  role=role||window.appMode||'viewer'; scsMigrateExistingGuides();
  if(!_scsGuideConfig[role]||localStorage.getItem(_scsGuideKey(role))) return;
  setTimeout(function(){scsOpenGuidedFunctions(role);},180);
}
function scsOpenGuidedFunctions(role){
  var cfg=_scsGuideConfig[role]; if(!cfg)return; _scsGuideRole=role;
  if(role==='organiser')_scsGuideRestoreSelectedPlayers();
  var overlay=document.getElementById('scsGuidedFunctions'); if(!overlay)return;
  // The helper is an app-level surface, never content within the currently
  // open Dashboard/Player/Club page. Reattach it to the document root in case
  // HTML recovery or a page renderer moved it into another stacking context.
  if(overlay.parentElement!==document.body) document.body.appendChild(overlay);
  overlay.style.setProperty('--guide-accent',cfg.accent); overlay.hidden=false; overlay.setAttribute('aria-hidden','false');
  document.body.classList.add('scs-guide-open');
  document.getElementById('scsGuideRoleIcon').textContent=cfg.icon; document.getElementById('scsGuideTitle').textContent=cfg.title; document.getElementById('scsGuideSubtitle').textContent=cfg.subtitle;
  var doneCount=0,current=null,html='';
  cfg.steps.forEach(function(step,i){
    var done=_scsGuideStepDone(role,step.id);
    var locked=role==='organiser'&&step.id==='round'&&!_scsGuideHasEnoughPlayers();
    if(done)doneCount++;
    else if(!locked&&!current)current=step;
    var description=locked?'Select at least 4 players first.':step.desc;
    html+='<button type="button" class="scs-guide-step '+(done?'is-done':((current&&current.id===step.id)?'is-current':''))+(locked?' is-disabled':'')+'"'+
      (locked?' disabled aria-disabled="true"':' aria-disabled="false"')+
      ' onclick="scsGuideChooseStep(\''+step.id+'\')"><span class="scs-guide-step-num">'+(done?'✓':(i+1))+'</span><span><div class="scs-guide-step-title">'+step.title+'</div><div class="scs-guide-step-desc">'+description+'</div></span><span class="scs-guide-step-arrow">›</span></button>';
  });
  document.getElementById('scsGuideSteps').innerHTML=html; document.getElementById('scsGuideProgressBar').style.width=Math.round(doneCount/cfg.steps.length*100)+'%';
  _scsGuideCurrentStep=current||cfg.steps[cfg.steps.length-1];
  if(!current){localStorage.setItem(_scsGuideKey(role),'complete');}
}
function scsGuideChooseStep(id){_scsGuideCurrentStep={id:id};scsRunGuidePrimary();}
function scsCloseGuidedFunctions(skip){var o=document.getElementById('scsGuidedFunctions');if(o){o.hidden=true;o.setAttribute('aria-hidden','true');}document.body.classList.remove('scs-guide-open');if(skip&&_scsGuideRole)localStorage.setItem(_scsGuideKey(_scsGuideRole),'dismissed');}

function scsOpenGuideChildPage(pageId,tabId,role){
  var page=document.getElementById(pageId);
  if(!page)return;
  role=role||_scsGuideRole||'organiser';
  _scsGuideRole=role;
  _scsGuideChildPageId=pageId;
  try{
    sessionStorage.setItem('scs_guide_child_page',pageId);
    sessionStorage.setItem('scs_guide_child_role',role);
  }catch(e){}

  // Keep Assist mounted underneath, exactly like the Player Assist children.
  if(typeof homeHideScreen==='function')homeHideScreen();
  if(typeof showPage==='function')showPage(pageId,tabId?document.getElementById(tabId):null);
  else page.style.display='block';

  page.classList.add('scs-assist-child-page');
  var oldClose=page.querySelector('.scs-assist-child-close');
  if(oldClose)oldClose.remove();
  var close=document.createElement('button');
  close.type='button';
  close.className='scs-assist-child-close scs-popup-close-btn';
  close.setAttribute('aria-label','Close and return to Assist');
  close.textContent='✕';
  close.onclick=scsGuideReturnFromChild;
  page.appendChild(close);
  document.body.classList.add('scs-guide-child-open');
}

function scsGuideReturnFromChild(){
  var pageId=_scsGuideChildPageId;
  var role=_scsGuideRole||'organiser';
  try{
    pageId=pageId||sessionStorage.getItem('scs_guide_child_page')||'';
    role=sessionStorage.getItem('scs_guide_child_role')||role;
    sessionStorage.removeItem('scs_guide_child_page');
    sessionStorage.removeItem('scs_guide_child_role');
  }catch(e){}
  var page=pageId?document.getElementById(pageId):document.querySelector('.scs-assist-child-page');
  if(page){
    page.classList.remove('scs-assist-child-page');
    page.style.display='none';
    var close=page.querySelector('.scs-assist-child-close');
    if(close)close.remove();
  }
  _scsGuideChildPageId='';
  document.body.classList.remove('scs-guide-child-open');
  setTimeout(function(){scsOpenGuidedFunctions(role);},60);
}

function scsGuideReturnFromJoinClub(){
  var fromAssist=false;
  var assistRole='viewer';
  try{fromAssist=sessionStorage.getItem('scs_join_club_from_assist')==='1';}catch(e){}
  if(!fromAssist){if(typeof showHomeScreen==='function')showHomeScreen();return;}
  try{assistRole=sessionStorage.getItem('scs_join_club_assist_role')||'viewer';}catch(e){}

  // Club Search launched from Assist is only a popup above Assist.
  // Close that popup and leave the underlying Assist page exactly where it was.
  var page=document.getElementById('joinClubPage');
  if(page){page.classList.remove('scs-assist-club-popup');page.style.display='none';}
  var backdrop=document.getElementById('scsAssistClubBackdrop');
  if(backdrop)backdrop.remove();
  document.body.classList.remove('scs-assist-club-open');
  try{
    sessionStorage.removeItem('scs_join_club_from_assist');
    sessionStorage.removeItem('scs_join_club_assist_role');
  }catch(e){}
  setTimeout(function(){scsOpenGuidedFunctions(assistRole);},80);
}

function scsGuideJoinClubCompleted(){
  var fromAssist=false;
  try{fromAssist=sessionStorage.getItem('scs_join_club_from_assist')==='1';}catch(e){}
  if(!fromAssist)return false;
  setTimeout(function(){scsGuideReturnFromJoinClub();},350);
  return true;
}

async function scsOpenJoinClubFromGuide(role){
  // Prepare the existing Club Search page off-screen first. It is revealed only
  // after memberships, pending requests and club data have finished rendering,
  // preventing flashing and changing popup dimensions.
  role=role||_scsGuideRole||'viewer';
  try{
    sessionStorage.setItem('scs_join_club_from_assist','1');
    sessionStorage.setItem('scs_join_club_assist_role',role);
  }catch(e){}
  var page=document.getElementById('joinClubPage');
  if(!page)return;

  var old=document.getElementById('scsAssistClubBackdrop');if(old)old.remove();
  var backdrop=document.createElement('div');
  backdrop.id='scsAssistClubBackdrop';
  backdrop.className='scs-assist-club-backdrop scs-assist-club-loading';
  backdrop.innerHTML='<div class="scs-assist-club-loader" role="status" aria-label="Loading clubs"><span></span></div>';
  document.body.appendChild(backdrop);
  document.body.classList.add('scs-assist-club-open');

  page.classList.add('scs-assist-club-popup','scs-assist-club-preparing');
  page.style.display='block';
  try{
    if(typeof joinClubPageOpen==='function') await joinClubPageOpen();
  }catch(e){console.warn('Assist club preload failed',e);}

  // Wait one paint so all calculated content sizes are settled before reveal.
  await new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(resolve);});});
  page.classList.remove('scs-assist-club-preparing');
  backdrop.classList.remove('scs-assist-club-loading');
  backdrop.innerHTML='';
  backdrop.onclick=function(e){if(e.target===backdrop)scsGuideReturnFromJoinClub();};
  setTimeout(function(){
    var input=document.getElementById('joinClubPageSearch');
    if(input){try{input.focus({preventScroll:true});}catch(e){input.focus();}}
  },80);
}

function scsRunGuidePrimary(){
  var role=_scsGuideRole,id=_scsGuideCurrentStep&&_scsGuideCurrentStep.id;
  // Player and Organiser actions open above the checklist. Closing the child
  // returns directly to the same role's Assist page.
  if(role==='viewer'){
    if(id==='nickname'){
      if(typeof authOpenNicknameEditor==='function'){
        var before=_scsGuideHasPlayerName(); authOpenNicknameEditor();
        var tries=0, timer=setInterval(function(){tries++; if(_scsGuideHasPlayerName()||tries>120){clearInterval(timer); if(_scsGuideHasPlayerName()&&!before)setTimeout(function(){scsOpenGuidedFunctions('viewer');},180);}},250);
      }
      return;
    }
    if(id==='gender'){scsGuideAskGender();return;}
    if(id==='club'){scsOpenJoinClubFromGuide('viewer');return;}
  }
  if(role==='vault'){
    scsCloseGuidedFunctions(false);
    if(id==='club'){_showClubSetupSheet('vault');if(typeof _clubSetupShowTab==='function')setTimeout(function(){_clubSetupShowTab('create');},60);return;}
    if(id==='players'&&typeof homeGo==='function'){homeGo('vaultRegisterPage',null);return;}
    if(id==='slot'&&typeof homeGo==='function'){homeGo('vaultSlotsPage',null);return;}
  }
  if(role==='organiser'){
    if(id==='club'){scsOpenJoinClubFromGuide('organiser');return;}
    if(id==='players'){
      _scsGuideRestoreSelectedPlayers();
      scsOpenGuideChildPage('playersPage','tabBtnPlayers','organiser');
      if(typeof updatePlayerList==='function')updatePlayerList();
      return;
    }
    if(id==='round'){
      if(!_scsGuideHasEnoughPlayers()){
        if(typeof showToast==='function')showToast('Select at least 4 players first.');
        scsOpenGuidedFunctions('organiser');
        return;
      }
      scsOpenGuideChildPage('roundsPage','tabBtnRounds','organiser');
      return;
    }
  }
}

/* Build 431: club-scoped hub photos and startup-prefetched welcome data. */
var welcomePhotoRole = 'viewer';
var welcomePhotoKeyAtSelection = '';

function welcomeNormalisePhotoRole(role) {
  return role === 'organiser' ? 'organiser' : (role === 'vault' ? 'vault' : 'viewer');
}

function welcomePhotoKeyPart(value) {
  return String(value || 'default').toLowerCase().replace(/[^a-z0-9_.@-]/g, '_');
}

function welcomePhotoIdentity() {
  var account = (typeof authGetUser === 'function') ? authGetUser() : null;
  var player = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
  var identity = (account && (account.id || account.user_id || account.email || account.nickname)) ||
                 (player && (player.id || player.user_id || player.email || player.name)) || 'default';
  return welcomePhotoKeyPart(identity);
}

function welcomeRoleClubInfo(role) {
  role = welcomeNormalisePhotoRole(role);
  if (role === 'organiser') return { id: localStorage.getItem('kbrr_org_club_id') || '', name: localStorage.getItem('kbrr_org_club_name') || '' };
  if (role === 'vault') return { id: localStorage.getItem('kbrr_vault_club_id') || '', name: localStorage.getItem('kbrr_vault_club_name') || '' };
  return { id: welcomePhotoIdentity(), name: '' };
}

function welcomeRolePhotoStorageKey(role) {
  role = welcomeNormalisePhotoRole(role);
  if (role === 'viewer') return 'scs_hub_photo_v6_viewer_' + welcomePhotoIdentity();
  var info = welcomeRoleClubInfo(role);
  if (!info.id) return '';
  return 'scs_hub_photo_v6_' + role + '_club_' + welcomePhotoKeyPart(info.id);
}

function welcomeGetSavedRolePhoto(role) {
  role = welcomeNormalisePhotoRole(role);
  var key = welcomeRolePhotoStorageKey(role);
  if (!key) return '';
  try {
    var saved = localStorage.getItem(key) || '';
    if (saved) return saved;

    // One-time migration only for the same resolved role/club. Never copy a
    // different club's "last" image into the current club.
    var info = welcomeRoleClubInfo(role);
    var legacy = role === 'viewer'
      ? ['scs_hub_photo_v5_viewer_' + welcomePhotoIdentity(), 'scs_welcome_profile_photo_' + welcomePhotoIdentity()]
      : [
          'scs_hub_photo_v5_' + role + '_id_' + welcomePhotoKeyPart(info.id),
          info.name ? 'scs_hub_photo_v5_' + role + '_name_' + welcomePhotoKeyPart(info.name) : '',
          'scs_hub_photo_v4_' + role + '_' + welcomePhotoKeyPart(info.id)
        ];
    for (var i = 0; i < legacy.length; i++) {
      if (!legacy[i]) continue;
      var oldPhoto = localStorage.getItem(legacy[i]) || '';
      if (!oldPhoto) continue;
      localStorage.setItem(key, oldPhoto);
      return oldPhoto;
    }
  } catch (e) { console.warn('Hub photo restore failed:', e); }
  return '';
}

function welcomeProfilePhotoStorageKey() { return welcomeRolePhotoStorageKey('viewer'); }
function welcomeGetSavedProfilePhoto() { return welcomeGetSavedRolePhoto('viewer'); }

function welcomeOpenPhotoMenu(role) {
  welcomePhotoRole = welcomeNormalisePhotoRole(role);
  welcomePhotoKeyAtSelection = welcomeRolePhotoStorageKey(welcomePhotoRole);
  if (!welcomePhotoKeyAtSelection && welcomePhotoRole !== 'viewer') {
    if (typeof showToast === 'function') showToast('Please wait for the club data to finish loading.');
    return;
  }
  var title = document.getElementById('welcomePhotoSheetTitle');
  if (title) title.textContent = welcomePhotoRole === 'viewer' ? 'Profile Photo' : 'Team Picture';
  var sheet = document.getElementById('welcomePhotoSheet');
  if (!sheet) return;
  sheet.hidden = false;
  requestAnimationFrame(function(){ sheet.classList.add('open'); });
  document.body.classList.add('welcome-photo-menu-open');
}

function welcomeRolePhotoElement(role) {
  role = welcomeNormalisePhotoRole(role);
  return document.getElementById(role === 'organiser' ? 'welcomeOrganiserPhoto' : (role === 'vault' ? 'welcomeVaultPhoto' : 'welcomePlayerPhoto'));
}

function welcomeSaveRolePhoto(role, dataUrl, fixedKey) {
  var key = fixedKey || welcomeRolePhotoStorageKey(role);
  if (!key) return false;
  try {
    localStorage.setItem(key, dataUrl);
    return localStorage.getItem(key) === dataUrl;
  } catch (e) {
    console.warn('Hub photo save failed:', e);
    return false;
  }
}

function welcomeHandleProfilePhoto(input) {
  var file = input && input.files && input.files[0];
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) { alert('Please select an image.'); return; }
  var roleAtSelection = welcomeNormalisePhotoRole(welcomePhotoRole);
  var keyAtSelection = welcomePhotoKeyAtSelection || welcomeRolePhotoStorageKey(roleAtSelection);
  var reader = new FileReader();
  reader.onerror = function(){ alert('Unable to read this photo. Please try another image.'); };
  reader.onload = function(event) {
    var image = new Image();
    image.onerror = function(){ alert('Unable to open this photo. Please try another image.'); };
    image.onload = function() {
      try {
        var w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
        var side = Math.min(w, h), sx = Math.max(0, (w-side)/2), sy = Math.max(0, (h-side)/2);
        var canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        canvas.getContext('2d').drawImage(image, sx, sy, side, side, 0, 0, 256, 256);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.68);
        if (!welcomeSaveRolePhoto(roleAtSelection, dataUrl, keyAtSelection)) {
          alert('The photo could not be saved. Please free some browser storage and try again.');
          return;
        }
        var photo = welcomeRolePhotoElement(roleAtSelection);
        if (photo) photo.src = dataUrl;
      } catch (e) { alert('The photo could not be saved. Please try another image.'); }
    };
    image.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function welcomeRemoveProfilePhoto() {
  var role = welcomeNormalisePhotoRole(welcomePhotoRole);
  var key = welcomePhotoKeyAtSelection || welcomeRolePhotoStorageKey(role);
  try { if (key) localStorage.removeItem(key); } catch (e) {}
  var photo = welcomeRolePhotoElement(role);
  if (photo) {
    if (role === 'viewer') {
      var player = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
      photo.src = player && player.gender === 'Female' ? 'female.png' : 'male.png';
    } else photo.src = 'male.png';
  }
  welcomeClosePhotoMenu();
}

function welcomeFlattenSlotMap(map) {
  var out = [];
  Object.keys(map || {}).forEach(function(date) { (map[date] || []).forEach(function(slot) { if (slot) out.push(slot); }); });
  return out;
}

function welcomeFindNextOrganiserSlot(slots) {
  var today = typeof localDateStr === 'function'
    ? localDateStr(new Date())
    : new Date().toISOString().slice(0,10);
  var now = new Date();
  var minutesNow = now.getHours() * 60 + now.getMinutes();
  return (slots || []).filter(function(slot) {
    var status = String(slot.status || '').toLowerCase();
    if (status !== 'posted' || String(slot.slot_date || '') !== today || slot.played_session_id) return false;
    var endParts = String(slot.end_time || '').match(/^(\d{1,2}):(\d{2})/);
    if (endParts) {
      var endMinutes = (parseInt(endParts[1], 10) || 0) * 60 + (parseInt(endParts[2], 10) || 0);
      if (minutesNow >= endMinutes) return false;
    }
    return true;
  }).sort(function(a,b) {
    return (String(a.slot_date || '') + ' ' + String(a.start_time || ''))
      .localeCompare(String(b.slot_date || '') + ' ' + String(b.start_time || ''));
  })[0] || null;
}

function welcomeRenderOrganiserClubPills() {
  var organiser = (window.__scsWelcomeHubData && window.__scsWelcomeHubData.organiser) || {};
  var clubs = Array.isArray(organiser.clubs) ? organiser.clubs : [];
  var selectedId = String(window.__scsWelcomeOrganiserChoice || organiser.clubId || '');
  var selectedClub = clubs.find(function(club) {
    return String(club.id) === selectedId;
  }) || clubs[0] || null;
  var container = document.getElementById('welcomeOrganiserClubPills');
  var fallbackName = document.getElementById('welcomeOrganiserName');
  if (!container) return;
  if (!selectedClub) {
    container.innerHTML = '';
    container.hidden = true;
    if (fallbackName) fallbackName.hidden = false;
    return;
  }
  container.hidden = false;
  if (fallbackName) fallbackName.hidden = true;
  container.innerHTML =
    '<span class="welcome-club-pill welcome-club-menu-pill selected" role="button" tabindex="0"' +
      ' aria-haspopup="dialog" data-club-id="' + organiserAccessEscape(selectedClub.id) + '"' +
      ' title="' + organiserAccessEscape(selectedClub.name || selectedClub.id) + '">' +
      '<span class="welcome-club-pill-dot" aria-hidden="true"></span>' +
      '<span class="welcome-club-pill-name">' + organiserAccessEscape(selectedClub.name || selectedClub.id) + '</span>' +
      '<span class="welcome-club-pill-arrow" aria-hidden="true">⌄</span></span>';
  var pill = container.querySelector('.welcome-club-menu-pill');
  if (pill) {
    pill.addEventListener('click', welcomeOpenOrganiserClubMenu);
    pill.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        welcomeOpenOrganiserClubMenu(event);
      }
    });
  }
}

async function welcomeOpenOrganiserClubMenu(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  var organiser = (window.__scsWelcomeHubData && window.__scsWelcomeHubData.organiser) || {};
  var clubs = Array.isArray(organiser.clubs) ? organiser.clubs : [];
  if (!clubs.length) {
    if (typeof showToast === 'function') showToast('No organiser clubs are available.');
    return;
  }
  var selected = await showOrganiserAccessMenu(clubs);
  if (selected && selected.id) {
    await welcomeSelectOrganiserClub(selected.id);
  }
}

async function welcomeSelectOrganiserClub(clubId) {
  var organiser = (window.__scsWelcomeHubData && window.__scsWelcomeHubData.organiser) || {};
  var clubs = Array.isArray(organiser.clubs) ? organiser.clubs : [];
  var selected = clubs.find(function(club) { return String(club.id) === String(clubId || ''); });
  if (!selected) return;

  window.__scsWelcomeOrganiserChoice = String(selected.id);
  organiser.clubId = String(selected.id);
  organiser.clubName = selected.name || '';
  organiser.nextSlot = null;
  localStorage.setItem('kbrr_org_club_id', String(selected.id));
  localStorage.setItem('kbrr_org_club_name', selected.name || '');
  sessionStorage.setItem('scs_organiser_verified', '1');
  localStorage.setItem('scs_organiser_verified', '1');
  welcomeRenderOrganiserClubPills();
  welcomeLoadRoleHubData('organiser');

  var container = document.getElementById('welcomeOrganiserClubPills');
  if (container) container.classList.add('is-loading');
  try {
    var today = typeof localDateStr === 'function' ? localDateStr(new Date()) : new Date().toISOString().slice(0,10);
    var endDate = new Date();
    endDate.setDate(endDate.getDate() + 60);
    var end = typeof localDateStr === 'function' ? localDateStr(endDate) : endDate.toISOString().slice(0,10);
    var slots = typeof dbGetSlotsForRange === 'function'
      ? await dbGetSlotsForRange(selected.id, today, today).catch(function() { return []; })
      : [];
    organiser.nextSlot = welcomeFindNextOrganiserSlot(slots);
    welcomeLoadRoleHubData('organiser');
  } finally {
    if (container) container.classList.remove('is-loading');
  }
}

async function scsPrefetchWelcomeHubData() {
  if (window.__scsWelcomeHubRefreshPromise) return window.__scsWelcomeHubRefreshPromise;
  var generation = ++window.__scsWelcomeHubRefreshGeneration;
  window.__scsWelcomeHubRefreshPromise = (async function() {
  var today = typeof localDateStr === 'function' ? localDateStr(new Date()) : new Date().toISOString().slice(0,10);
  var endDate = new Date();
  endDate.setDate(endDate.getDate() + 60);
  var end = typeof localDateStr === 'function' ? localDateStr(endDate) : endDate.toISOString().slice(0,10);
  var user = (typeof authGetUser === 'function') ? authGetUser() : null;

  // Player hub uses the same account-linked memberships and aggregation as
  // My Card. The small local player profile contains only identity fields and
  // must not be used as the source of rating or points.
  var playerMemberships = [];
  if (user && user.id && typeof sbGet === 'function') {
    playerMemberships = await sbGet('memberships',
      'user_account_id=eq.' + encodeURIComponent(user.id) +
      '&select=player_id,club_id,club_rating,club_points').catch(function(error) {
        console.warn('Player hub prefetch failed:', error);
        return [];
      });
  }
  var ratingTotal = 0;
  var ratingCount = (playerMemberships || []).length;
  var pointsTotal = 0;
  (playerMemberships || []).forEach(function(membership) {
    var rating = parseFloat(membership.club_rating);
    if (Number.isFinite(rating)) ratingTotal += rating;
    var points = parseFloat(membership.club_points);
    if (Number.isFinite(points)) pointsTotal += points;
  });
  var playerIds = Array.from(new Set((playerMemberships || []).map(function(membership) {
    return membership && membership.player_id ? String(membership.player_id) : '';
  }).filter(Boolean)));
  if (user && user.id && typeof sbGet === 'function') {
    var accountPlayers = await sbGet('players',
      'user_account_id=eq.' + encodeURIComponent(user.id) + '&select=id').catch(function() { return []; });
    (accountPlayers || []).forEach(function(playerRow) {
      if (playerRow && playerRow.id && playerIds.indexOf(String(playerRow.id)) < 0) {
        playerIds.push(String(playerRow.id));
      }
    });
  }
  var bookedSlots = 0;
  if (playerIds.length && typeof sbGet === 'function') {
    var bookedClaims = await sbGet('slot_claims',
      'player_id=in.(' + playerIds.join(',') + ')&status=eq.confirmed&select=slot_id').catch(function() { return []; });
    var bookedSlotIds = Array.from(new Set((bookedClaims || []).map(function(claim) {
      return claim && claim.slot_id ? String(claim.slot_id) : '';
    }).filter(Boolean)));
    if (bookedSlotIds.length) {
      var bookedRows = await sbGet('slots',
        'id=in.(' + bookedSlotIds.join(',') + ')&slot_date=gte.' + today +
        '&status=in.(posted,scheduled)&select=id').catch(function() { return []; });
      bookedSlots = new Set((bookedRows || []).map(function(slot) { return String(slot.id); })).size;
    }
  }
  var clubCount = new Set((playerMemberships || []).map(function(membership) {
    return membership && membership.club_id ? String(membership.club_id) : '';
  }).filter(Boolean)).size;
  var localPlayer = (typeof getMyPlayer === 'function') ? getMyPlayer() : null;
  var playerData = {
    name: (user && (user.nickname || user.displayName)) ||
      (localPlayer && (localPlayer.displayName || localPlayer.name || localPlayer.nickname)) || 'Player',
    gender: (user && user.gender) || (localPlayer && localPlayer.gender) || 'Male',
    clubs: clubCount,
    bookedSlots: bookedSlots,
    rating: ratingCount ? ratingTotal / ratingCount : 0,
    points: pointsTotal
  };

  // Organiser access follows membership. Resolve the current/first eligible
  // club before querying slots instead of assuming its localStorage keys were
  // already populated when the document started.
  var organiserOptions = (typeof getOrganiserEligibleClubs === 'function')
    ? await getOrganiserEligibleClubs(user).catch(function() { return []; })
    : [];
  var cachedOrganiserId = localStorage.getItem('kbrr_org_club_id') || '';
  var organiserClub = (organiserOptions || []).find(function(club) {
    return String(club.id) === String(cachedOrganiserId);
  }) || (organiserOptions && organiserOptions[0]) || null;
  var organiserClubId = organiserClub ? String(organiserClub.id || '') : cachedOrganiserId;
  var organiserClubName = (organiserClub && organiserClub.name) ||
    localStorage.getItem('kbrr_org_club_name') || 'Club';
  var vaultClubId = localStorage.getItem('kbrr_vault_club_id') || '';
  var vaultClubName = localStorage.getItem('kbrr_vault_club_name') || 'Club';

  var organiserSlots = [];
  if (organiserClubId && typeof dbGetSlotsForRange === 'function') {
    organiserSlots = await dbGetSlotsForRange(organiserClubId, today, today).catch(function(error) {
      console.warn('Organiser hub prefetch failed:', error); return [];
    });
  }
  var next = welcomeFindNextOrganiserSlot(organiserSlots);
  var organiserData = {
    clubId: organiserClubId,
    clubName: organiserClubName,
    clubs: organiserOptions || [],
    nextSlot: next
  };

  var members = [];
  if (vaultClubId && typeof sbGet === 'function') {
    members = await sbGet('memberships', 'club_id=eq.' + encodeURIComponent(vaultClubId) + '&select=id').catch(function(error) {
      console.warn('Club member hub prefetch failed:', error); return [];
    });
  }
  // Query the authoritative slot range directly. The Vault calendar map may
  // still be empty when Welcome opens even though the workspace later loads it.
  var vaultSlots = [];
  if (vaultClubId && typeof dbGetSlotsForRange === 'function') {
    vaultSlots = await dbGetSlotsForRange(vaultClubId, today, end).catch(function(error) {
      console.warn('Club slot hub prefetch failed:', error); return [];
    });
  }
  var activeSlots = (vaultSlots || []).filter(function(slot) {
    var status = String(slot.status || '').toLowerCase();
    return ['posted','scheduled'].indexOf(status) >= 0 && String(slot.slot_date || '') >= today && !slot.played_session_id;
  });
  var postedSlots = (vaultSlots || []).filter(function(slot) {
    return String(slot.status || '').toLowerCase() === 'posted' &&
      String(slot.slot_date || '') >= today && !slot.played_session_id;
  });
  var draftSlots = (vaultSlots || []).filter(function(slot) {
    return String(slot.status || '').toLowerCase() === 'draft' &&
      String(slot.slot_date || '') >= today && !slot.played_session_id;
  });
  var unpaidCount = 0;
  (vaultSlots || []).forEach(function(slot) {
    var cost = typeof _vsSlotCostPerPlayer === 'function'
      ? _vsSlotCostPerPlayer(slot)
      : Number(slot && slot.cost_per_player || 0);
    if (!(cost > 0)) return;
    (slot.claims || []).forEach(function(claim) {
      if (String(claim && claim.status || '').toLowerCase() === 'confirmed' && !claim.paid_at) {
        unpaidCount += 1;
      }
    });
  });
  var vaultData = {
    clubId: vaultClubId,
    clubName: vaultClubName,
    members: members.length,
    activeSlots: activeSlots.length,
    postedSlots: postedSlots.length,
    draftSlots: draftSlots.length,
    unpaid: unpaidCount
  };

  if (generation === window.__scsWelcomeHubRefreshGeneration) {
    window.__scsWelcomeHubData = {
      player: playerData,
      organiser: organiserData,
      vault: vaultData,
      refreshedAt: Date.now()
    };
    welcomeApplyAllHubData();
  }
  return window.__scsWelcomeHubData;
  })().finally(function() {
    window.__scsWelcomeHubRefreshPromise = null;
  });
  return window.__scsWelcomeHubRefreshPromise;
}
window.scsPrefetchWelcomeHubData = scsPrefetchWelcomeHubData;

function welcomeApplyPlayerHubData() {
  var data = (window.__scsWelcomeHubData && window.__scsWelcomeHubData.player) || null;
  if (!data) return;
  var photo = document.getElementById('welcomePlayerPhoto');
  var nameEl = document.getElementById('welcomePlayerName');
  var ratingEl = document.getElementById('welcomePlayerRating');
  var pointsEl = document.getElementById('welcomePlayerPoints');
  var clubsEl = document.getElementById('welcomePlayerClubs');
  var bookedEl = document.getElementById('welcomePlayerBookedSlots');
  if (photo) photo.src = welcomeGetSavedRolePhoto('viewer') ||
    (data.gender === 'Female' ? 'female.png' : 'male.png');
  if (nameEl) {
    nameEl.textContent = data.name || 'Player';
    nameEl.hidden = false;
  }
  if (ratingEl) ratingEl.textContent = Number(data.rating || 0).toFixed(1);
  if (pointsEl) pointsEl.textContent = Number(data.points || 0).toFixed(1);
  if (clubsEl) clubsEl.textContent = String(Number(data.clubs || 0));
  if (bookedEl) bookedEl.textContent = String(Number(data.bookedSlots || 0));
}

async function welcomeLoadRoleHubData(mode) {
  var data = window.__scsWelcomeHubData || {};
  if (mode === 'organiser') {
    var organiser = data.organiser || {};
    var orgPhoto = document.getElementById('welcomeOrganiserPhoto');
    if (orgPhoto) orgPhoto.src = welcomeGetSavedRolePhoto('organiser') || 'male.png';
    var orgName = document.getElementById('welcomeOrganiserName');
    if (orgName) orgName.textContent = organiser.clubName || localStorage.getItem('kbrr_org_club_name') || 'Club';
    if (!window.__scsWelcomeOrganiserChoice && organiser.clubId) {
      window.__scsWelcomeOrganiserChoice = String(organiser.clubId);
    }
    welcomeRenderOrganiserClubPills();
    var title = document.getElementById('welcomeOrganiserNextSlotTitle');
    var meta = document.getElementById('welcomeOrganiserNextSlotMeta');
    var roundTile = document.getElementById('welcomeOrganiserNextSlot');
    var next = organiser.nextSlot || null;
    if (next) {
      if (title) title.textContent = organiser.clubName || next._viewerClubName || 'Club';
      if (meta) meta.textContent = String(next.slot_date || '') + ' · ' + String(next.start_time || '').slice(0,5) + (next.venue ? ' · ' + next.venue : '');
      if (roundTile) {
        roundTile.classList.add('has-slot');
        roundTile.setAttribute('aria-disabled', 'false');
        roundTile.setAttribute('tabindex', '0');
      }
    } else {
      if (title) title.textContent = 'No slot today';
      if (meta) meta.textContent = 'A posted slot today will appear here.';
      if (roundTile) {
        roundTile.classList.remove('has-slot', 'is-opening');
        roundTile.setAttribute('aria-disabled', 'true');
        roundTile.setAttribute('tabindex', '-1');
      }
    }
  }
  if (mode === 'vault') {
    var vault = data.vault || {};
    var vaultPhoto = document.getElementById('welcomeVaultPhoto');
    if (vaultPhoto) vaultPhoto.src = welcomeGetSavedRolePhoto('vault') || 'male.png';
    var vaultName = document.getElementById('welcomeVaultName');
    if (vaultName) vaultName.textContent = vault.clubName || localStorage.getItem('kbrr_vault_club_name') || 'Club';
    var membersEl = document.getElementById('welcomeVaultMembers');
    var postedEl = document.getElementById('welcomeVaultPostedSlots');
    var draftEl = document.getElementById('welcomeVaultDraftSlots');
    var unpaidEl = document.getElementById('welcomeVaultUnpaid');
    if (membersEl) membersEl.textContent = String(Number(vault.members || 0));
    if (postedEl) postedEl.textContent = String(Number(vault.postedSlots || 0));
    if (draftEl) draftEl.textContent = String(Number(vault.draftSlots || 0));
    if (unpaidEl) unpaidEl.textContent = String(Number(vault.unpaid || 0));
  }
}

function welcomeApplyAllHubData() {
  welcomeApplyPlayerHubData();
  welcomeLoadRoleHubData('organiser');
  welcomeLoadRoleHubData('vault');
  updateWelcomeWorkspaceClubNames();
}

var _welcomeUpdateHubCard422 = updateWelcomeHubCard;
updateWelcomeHubCard = function(mode) {
  _welcomeUpdateHubCard422(mode);
  welcomeApplyAllHubData();
};

function welcomeRefreshHubIfVisible(force) {
  var overlay = document.getElementById('modeSelectOverlay');
  if (!overlay || overlay.style.display === 'none' || document.visibilityState === 'hidden') return;
  var refreshedAt = Number(window.__scsWelcomeHubData && window.__scsWelcomeHubData.refreshedAt || 0);
  if (!force && refreshedAt && Date.now() - refreshedAt < 15000) {
    welcomeApplyAllHubData();
    return;
  }
  if (typeof window.scsPrefetchWelcomeHubData === 'function') {
    window.scsPrefetchWelcomeHubData().catch(function(error) {
      console.warn('Visible welcome hub refresh skipped:', error);
    });
  }
}
window.welcomeRefreshHubIfVisible = welcomeRefreshHubIfVisible;

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') welcomeRefreshHubIfVisible(false);
});
window.addEventListener('pageshow', function() {
  welcomeRefreshHubIfVisible(false);
});
