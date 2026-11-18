/* Encore: a camera for live music.
 * Each capture = photo + short live-audio clip + location.
 * Enrichment (song, venue, facts, night) runs after saving and retries when back online.
 */
(() => {
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  function distM(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return Infinity;
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function fetchJSON(url, opts = {}, timeout = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------- storage (IndexedDB) ----------
  const DB = {
    db: null,
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('encore', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('captures', { keyPath: 'id' }).createIndex('ts', 'ts');
          db.createObjectStore('events', { keyPath: 'id' }).createIndex('start', 'start');
        };
        req.onsuccess = () => { this.db = req.result; resolve(); };
        req.onerror = () => reject(req.error);
      });
    },
    tx(store, mode, fn) {
      return new Promise((resolve, reject) => {
        const t = this.db.transaction(store, mode);
        const s = t.objectStore(store);
        const out = fn(s);
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
        t.onerror = () => reject(t.error);
      });
    },
    put(store, obj) { return this.tx(store, 'readwrite', (s) => s.put(obj)); },
    get(store, id) { return this.tx(store, 'readonly', (s) => s.get(id)); },
    del(store, id) { return this.tx(store, 'readwrite', (s) => s.delete(id)); },
    all(store) { return this.tx(store, 'readonly', (s) => s.getAll()); },
  };

  // ---------- settings ----------
  const Settings = {
    get key() { return lsGet('encore.key', '').trim(); },
    get secs() { return parseInt(lsGet('encore.secs', '10'), 10) || 10; },
    get proxy() { return lsGet('encore.proxy', '').trim().replace(/\/+$/, ''); },
  };

  // ---------- object URLs (revoked on view change) ----------
  let urls = [];
  const blobURL = (b) => { if (!b) return ''; const u = URL.createObjectURL(b); urls.push(u); return u; };
  const freeURLs = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };

  // ---------- navigation ----------
  let currentView = 'camera';
  let returnTo = 'camera';
  function go(name) {
    if (currentView === 'capture' || currentView === 'night' || currentView === 'nights') {
      const a = $('#capture-body audio'); if (a) a.pause();
    }
    if (name !== 'capture' && name !== 'night') freeURLs();
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('#view-' + name).classList.add('active');
    currentView = name;
    if (name === 'nights') renderNights();
    if (name === 'settings') renderSettings();
    if (name === 'camera') refreshLastThumb();
  }
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) go(g.dataset.go);
  });

  // ---------- camera ----------
  const video = $('#viewfinder');
  let stream = null;
  let facing = 'environment';
  let busy = false;

  async function startCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      $('#cam-start').hidden = true;
      lsSet('encore.started', '1');
      startLocation();
    } catch (err) {
      console.error(err);
      $('#cam-start').hidden = false;
      toast('Camera or microphone was blocked. Allow them in Settings › Safari, then try again.', 5000);
    }
  }

  function grabPhoto() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return Promise.resolve(null);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  }

  function pickMime() {
    const types = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  function recordAudio(secs, onTick) {
    return new Promise((resolve) => {
      const tracks = stream ? stream.getAudioTracks() : [];
      if (!tracks.length || !window.MediaRecorder) return resolve(null);
      const mime = pickMime();
      const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      rec.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || mime || 'audio/mp4' }) : null);
      rec.start();
      const t0 = performance.now();
      const tick = () => {
        const el = (performance.now() - t0) / 1000;
        onTick(Math.min(el / secs, 1), Math.max(0, Math.ceil(secs - el)));
        if (el >= secs) { if (rec.state !== 'inactive') rec.stop(); }
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async function shoot() {
    if (busy || !stream) return;
    busy = true;
    $('#btn-shutter').disabled = true;
    const flash = $('#flash');
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    if (navigator.vibrate) navigator.vibrate(30);

    const ts = Date.now();
    const photo = await grabPhoto();
    const loc = lastLoc && Date.now() - lastLoc.at < 5 * 60 * 1000 ? { ...lastLoc } : null;

    const secs = Settings.secs;
    const ring = $('#ring-fg'), lbl = $('#listen-secs');
    $('#listening').hidden = false;
    const audio = await recordAudio(secs, (p, left) => {
      ring.style.strokeDashoffset = String(339.3 * (1 - p));
      lbl.textContent = left;
    });
    $('#listening').hidden = true;
    ring.style.strokeDashoffset = '339.3';

    const cap = {
      id: uid(), ts, photo, audio, audioType: audio ? audio.type : null,
      loc: loc ? { lat: loc.lat, lon: loc.lon, acc: loc.acc } : null,
      venue: null, song: null, recog: 'pending', facts: null, eventId: null,
    };
    await DB.put('captures', cap);
    refreshLastThumb();
    busy = false;
    $('#btn-shutter').disabled = false;
    toast('Saved. Working out the song…');
    enrich(cap.id);
  }

  // ---------- location ----------
  let lastLoc = null;
  let chipVenue = null;
  let chipLookupAt = 0;
  let watchId = null;

  function startLocation() {
    if (!navigator.geolocation || watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        lastLoc = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
        updateChip();
      },
      () => { $('#venue-chip-text').textContent = 'Location off – photos will still save'; },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 },
    );
  }

  async function updateChip() {
    if (!lastLoc || Date.now() - chipLookupAt < 120000) return;
    chipLookupAt = Date.now();
    try {
      chipVenue = await findVenue(lastLoc);
      $('#venue-chip-text').textContent = chipVenue ? chipVenue.name : 'Location found';
      $('#venue-chip').classList.add('live');
    } catch {
      $('#venue-chip-text').textContent = navigator.onLine ? 'Location found' : 'Offline – will look up later';
      $('#venue-chip').classList.add('live');
    }
  }

  // Look for a named venue within ~150m (OpenStreetMap), else fall back to the street/suburb.
  async function findVenue(loc) {
    const { lat, lon } = loc;
    const r = Math.max(120, Math.min(300, (loc.acc || 50) * 1.5));
    const q = `[out:json][timeout:10];(
      nwr(around:${r},${lat},${lon})["name"]["amenity"~"^(nightclub|bar|pub|theatre|arts_centre|events_venue|music_venue|concert_hall|community_centre|restaurant|cafe|biergarten|stage)$"];
      nwr(around:${r},${lat},${lon})["name"]["leisure"~"^(stadium|park|garden|festival_ground|bandstand|beach_resort|sports_centre)$"];
      nwr(around:${r},${lat},${lon})["name"]["tourism"~"^(attraction|museum|gallery|wine_farm)$"];
      nwr(around:${r},${lat},${lon})["name"]["building"~"^(stadium|theatre)$"];
    );out center tags 40;`;
    try {
      const d = await fetchJSON('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 12000);
      const rank = { nightclub: 0, music_venue: 0, concert_hall: 0, events_venue: 0, stage: 0, theatre: 1, arts_centre: 1, stadium: 1, festival_ground: 0, bandstand: 1, bar: 2, pub: 2, biergarten: 2, wine_farm: 2 };
      const best = (d.elements || [])
        .map((e) => {
          const t = e.tags || {};
          const p = e.center || { lat: e.lat, lon: e.lon };
          const kind = t.amenity || t.leisure || t.tourism || t.building || 'place';
          return { name: t.name, kind, lat: p.lat, lon: p.lon, d: distM(loc, p), r: rank[kind] ?? 3 };
        })
        .filter((v) => v.name && v.lat != null)
        .sort((a, b) => (a.d + a.r * 40) - (b.d + b.r * 40))[0];
      if (best) return { name: best.name, kind: best.kind, lat: best.lat, lon: best.lon, area: await areaName(loc).catch(() => '') };
    } catch (e) { console.warn('overpass', e); }

    const n = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`);
    const a = n.address || {};
    const name = n.name || a.amenity || a.leisure || a.road || a.suburb || a.city || 'Somewhere';
    return { name, kind: n.type || 'place', lat, lon, area: [a.suburb, a.city || a.town].filter(Boolean).join(', ') };
  }

  async function areaName({ lat, lon }) {
    const n = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lon}`, {}, 8000);
    const a = n.address || {};
    return [a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(', ');
  }

  // ---------- song recognition (AudD) ----------
  async function recognise(cap) {
    if (!cap.audio) return { recog: 'noaudio' };
    if (!Settings.key) return { recog: 'nokey' };
    const fd = new FormData();
    const ext = (cap.audioType || '').includes('webm') ? 'webm' : 'm4a';
    fd.append('api_token', Settings.key);
    fd.append('file', cap.audio, 'clip.' + ext);
    fd.append('return', 'apple_music,spotify,deezer');
    const endpoint = Settings.proxy ? Settings.proxy + '/recognize' : 'https://api.audd.io/';
    let d;
    try {
      d = await fetchJSON(endpoint, { method: 'POST', body: fd }, 30000);
    } catch (e) {
      if (!navigator.onLine) return { recog: 'pending' };
      // A network-level TypeError while online usually means the browser blocked the call (CORS)
      return { recog: e.name === 'TypeError' ? 'blocked' : 'error', recogMsg: String(e.message || e) };
    }
    if (d.status !== 'success') return { recog: 'error', recogMsg: d.error ? d.error.error_message : 'Recognition failed' };
    if (!d.result) return { recog: 'none' };
    const r = d.result;
    const am = r.apple_music || {}, sp = r.spotify || {}, dz = r.deezer || {};
    let cover = '';
    if (am.artwork && am.artwork.url) cover = am.artwork.url.replace('{w}', '400').replace('{h}', '400');
    else if (sp.album && sp.album.images && sp.album.images[0]) cover = sp.album.images[0].url;
    else if (dz.album && dz.album.cover_big) cover = dz.album.cover_big;
    const q = encodeURIComponent(`${r.artist} ${r.title}`);
    return {
      recog: 'found',
      song: {
        title: r.title, artist: r.artist, album: r.album, released: r.release_date, label: r.label, cover,
        links: {
          all: r.song_link || '',
          apple: am.url || '',
          spotify: (sp.external_urls && sp.external_urls.spotify) || '',
          deezer: dz.link || '',
          youtube: `https://music.youtube.com/search?q=${q}`,
        },
      },
    };
  }

  // ---------- facts (Wikipedia) ----------
  const WIKI = 'https://en.wikipedia.org/w/api.php?format=json&origin=*&';

  async function wikiIntro(pageids) {
    if (!pageids.length) return [];
    const d = await fetchJSON(WIKI + 'action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exsentences=2&pageids=' + pageids.join('|'));
    return Object.values((d.query && d.query.pages) || {})
      .filter((p) => p.extract && !/may refer to/.test(p.extract))
      .map((p) => ({ title: p.title, text: p.extract, url: p.fullurl }));
  }

  async function artistFact(artist) {
    const d = await fetchJSON(WIKI + 'action=query&list=search&srlimit=1&srsearch=' + encodeURIComponent(`${artist} musician OR band OR singer`));
    const hit = d.query && d.query.search && d.query.search[0];
    if (!hit) return null;
    const [f] = await wikiIntro([hit.pageid]);
    return f ? { ...f, tag: 'About the artist' } : null;
  }

  async function placeFacts(loc) {
    const d = await fetchJSON(WIKI + `action=query&list=geosearch&gsradius=10000&gslimit=12&gscoord=${loc.lat}|${loc.lon}`);
    const hits = ((d.query && d.query.geosearch) || []).slice(0, 6);
    const facts = await wikiIntro(hits.slice(0, 3).map((h) => h.pageid));
    return facts.slice(0, 2).map((f) => {
      const h = hits.find((x) => x.title === f.title);
      const dist = h ? (h.dist < 1000 ? `${Math.round(h.dist)} m away` : `${(h.dist / 1000).toFixed(1)} km away`) : '';
      return { ...f, tag: dist ? `Nearby · ${dist}` : 'Nearby' };
    });
  }

  async function onThisDay(ts) {
    const dt = new Date(ts);
    const mm = String(dt.getMonth() + 1).padStart(2, '0'), dd = String(dt.getDate()).padStart(2, '0');
    const d = await fetchJSON(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`);
    const evs = d.events || [];
    const musical = evs.filter((e) => /music|album|song|concert|band|singer|record|festival|guitar|jazz|rock|hip hop|opera/i.test(e.text));
    const pool = musical.length ? musical : evs;
    if (!pool.length) return null;
    const e = pool[Math.floor(Math.random() * pool.length)];
    const page = e.pages && e.pages[0];
    return { tag: `On this day · ${e.year}`, title: musical.length ? 'Music history' : 'History', text: e.text, url: page && page.content_urls ? page.content_urls.mobile.page : '' };
  }

  async function gatherFacts(cap) {
    const jobs = [];
    if (cap.song) jobs.push(artistFact(cap.song.artist).then((f) => (f ? [f] : [])));
    if (cap.loc) jobs.push(placeFacts(cap.loc));
    jobs.push(onThisDay(cap.ts).then((f) => (f ? [f] : [])));
    const res = await Promise.allSettled(jobs);
    const facts = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    // With a song we lead with the artist; without one, place facts first then history.
    return facts.slice(0, cap.song ? 3 : 3);
  }

  // ---------- nights (auto event grouping) ----------
  const NIGHT_GAP_MS = 4 * 60 * 60 * 1000;
  const SAME_PLACE_M = 600;

  async function assignNight(cap) {
    const events = await DB.all('events');
    let ev = events
      .filter((e) => cap.ts >= e.start - NIGHT_GAP_MS && cap.ts <= e.end + NIGHT_GAP_MS)
      .filter((e) => !cap.loc || !e.loc || distM(cap.loc, e.loc) < SAME_PLACE_M)
      .sort((a, b) => Math.abs(cap.ts - a.end) - Math.abs(cap.ts - b.end))[0];
    if (!ev) {
      ev = { id: uid(), name: '', autoName: true, start: cap.ts, end: cap.ts, loc: cap.loc, venueName: cap.venue ? cap.venue.name : '', area: cap.venue ? cap.venue.area : '' };
    }
    ev.start = Math.min(ev.start, cap.ts);
    ev.end = Math.max(ev.end, cap.ts);
    if (!ev.loc && cap.loc) ev.loc = cap.loc;
    if (!ev.venueName && cap.venue) { ev.venueName = cap.venue.name; ev.area = cap.venue.area; }
    await DB.put('events', ev);
    return ev.id;
  }

  async function nightCaptures(eventId) {
    return (await DB.all('captures')).filter((c) => c.eventId === eventId).sort((a, b) => a.ts - b.ts);
  }

  async function autoNameNight(eventId) {
    const ev = await DB.get('events', eventId);
    if (!ev || !ev.autoName) return;
    const caps = await nightCaptures(eventId);
    const counts = {};
    caps.forEach((c) => { if (c.song) counts[c.song.artist] = (counts[c.song.artist] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const venue = ev.venueName || 'Somewhere';
    let name;
    // Same artist twice or more = probably their show. Otherwise, it's the venue's night.
    if (top.length && top[0][1] >= 2) name = `${top[0][0]} at ${venue}`;
    else name = venue;
    ev.name = name;
    await DB.put('events', ev);
  }

  // ---------- enrichment pipeline ----------
  const enriching = new Set();
  async function enrich(id) {
    if (enriching.has(id)) return;
    enriching.add(id);
    try {
      let cap = await DB.get('captures', id);
      if (!cap) return;
      const save = async (patch) => { cap = { ...(await DB.get('captures', id)), ...patch }; await DB.put('captures', cap); refreshOpen(id, cap.eventId); };

      if (cap.loc && !cap.venue) {
        const near = chipVenue && distM(cap.loc, chipVenue) < 150 ? chipVenue : null;
        const v = near || await findVenue(cap.loc).catch(() => null);
        if (v) await save({ venue: v });
      }
      if (cap.recog === 'pending' || cap.recog === 'nokey' || cap.recog === 'blocked' || cap.recog === 'error') {
        const r = await recognise(cap);
        await save(r);
        if (r.recog === 'found') toast(`♪ ${r.song.title} — ${r.song.artist}`, 3500);
        else if (r.recog === 'none') toast('No song recognised. Saved with facts instead.');
        else if (r.recog === 'nokey') toast('Add your song recognition key in Settings to identify songs.', 4000);
        else if (r.recog === 'blocked') toast('Recognition was blocked. See Settings › Relay.', 4000);
      }
      if (!cap.facts && navigator.onLine) {
        const facts = await gatherFacts(cap).catch(() => null);
        if (facts && facts.length) await save({ facts });
      }
      if (!cap.eventId) {
        const eventId = await assignNight(cap);
        await save({ eventId });
      }
      await autoNameNight(cap.eventId);
      refreshOpen(id, cap.eventId);
    } catch (e) {
      console.error('enrich', e);
    } finally {
      enriching.delete(id);
    }
  }

  async function retryAll() {
    const caps = await DB.all('captures');
    const todo = caps.filter((c) => c.recog === 'pending' || c.recog === 'error' || c.recog === 'blocked' || (c.recog === 'nokey' && Settings.key) || !c.eventId || (!c.facts && navigator.onLine) || (c.loc && !c.venue));
    for (const c of todo) { await enrich(c.id); await sleep(400); }
    return todo.length;
  }

  // ---------- rendering ----------
  async function refreshLastThumb() {
    const caps = await DB.all('captures');
    const last = caps.sort((a, b) => b.ts - a.ts)[0];
    const btn = $('#btn-last');
    if (btn.dataset.url) URL.revokeObjectURL(btn.dataset.url);
    if (last && last.photo) {
      const u = URL.createObjectURL(last.photo);
      btn.dataset.url = u; btn.dataset.id = last.id;
      btn.style.backgroundImage = `url("${u}")`;
    } else { btn.style.backgroundImage = ''; btn.dataset.id = ''; }
  }

  let openCaptureId = null;
  let openNightId = null;
  function refreshOpen(capId, eventId) {
    if (currentView === 'capture' && openCaptureId === capId) renderCapture(capId, true);
    if (currentView === 'night' && openNightId && openNightId === eventId) renderNight(eventId);
    if (currentView === 'nights') renderNights();
  }

  const ICON = {
    pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    night: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  };

  function songBlock(c) {
    switch (c.recog) {
      case 'found': {
        const s = c.song, L = s.links;
        const link = (href, label, main) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener"${main ? ' class="main"' : ''}>${label}</a>` : '');
        return `<div class="card">
          <div class="song">
            <div class="art" style="${s.cover ? `background-image:url('${esc(s.cover)}')` : ''}"></div>
            <div><h3>${esc(s.title)}</h3><div class="artist">${esc(s.artist)}</div>
            ${s.album ? `<div class="fine">${esc(s.album)}${s.released ? ' · ' + esc(String(s.released).slice(0, 4)) : ''}</div>` : ''}</div>
          </div>
          <div class="links">
            ${link(L.all, 'All platforms', true)}${link(L.apple, 'Apple Music')}${link(L.spotify, 'Spotify')}${link(L.deezer, 'Deezer')}${link(L.youtube, 'YouTube Music')}
          </div></div>`;
      }
      case 'pending':
        return `<div class="card status"><div class="spinner"></div><div>${navigator.onLine ? 'Identifying the song…' : 'Offline. The song will be identified when you\'re back online.'}</div></div>`;
      case 'none':
        return `<div class="card status"><div>🎧</div><div>No song recognised, either no music or too much crowd noise. The sound clip is saved below.</div></div>`;
      case 'nokey':
        return `<div class="card status"><div>🔑</div><div>Add your song recognition key in <button class="link-btn" data-go="settings">Settings</button> to identify this song.</div></div>`;
      case 'blocked':
        return `<div class="card status"><div>⚠️</div><div>Your phone blocked the recognition request. Set up the relay in Settings, then tap "Retry unfinished photos".</div></div>`;
      case 'noaudio':
        return `<div class="card status"><div>🔇</div><div>No sound was recorded for this photo.</div></div>`;
      default:
        return `<div class="card status"><div>⚠️</div><div>Couldn't identify the song${c.recogMsg ? ` (${esc(c.recogMsg)})` : ''}. Try "Retry unfinished photos" in Settings.</div></div>`;
    }
  }

  async function renderCapture(id, keepAudio) {
    const c = await DB.get('captures', id);
    if (!c) { go(returnTo); return; }
    openCaptureId = id;
    const body = $('#capture-body');
    const audioEl = body.querySelector('audio');
    const wasPlaying = keepAudio && audioEl && !audioEl.paused;
    if (wasPlaying) return; // don't interrupt playback with a re-render
    const ev = c.eventId ? await DB.get('events', c.eventId) : null;
    const photoU = blobURL(c.photo), audioU = blobURL(c.audio);
    const facts = c.facts || [];
    body.innerHTML = `
      <img class="photo" src="${photoU}" alt="Photo taken ${esc(fmtTime(c.ts))}">
      ${songBlock(c)}
      ${c.audio ? `<div class="card player">
        <button class="play-btn" id="play" aria-label="Play sound">${ICON.play}</button>
        <div class="player-meta"><strong>The moment, live</strong>What it sounded like when you took this</div>
        <audio src="${audioU}" preload="metadata"></audio></div>` : ''}
      <div class="card">
        <div class="kv"><span class="ic">${ICON.pin}</span><div>${c.venue ? esc(c.venue.name) : c.loc ? 'Looking up the place…' : 'No location'}${c.venue && c.venue.area ? `<small>${esc(c.venue.area)}</small>` : ''}</div></div>
        <div class="kv"><span class="ic">${ICON.clock}</span><div>${esc(fmtTime(c.ts))}<small>${esc(fmtDate(c.ts))}</small></div></div>
        ${ev ? `<div class="kv"><span class="ic">${ICON.night}</span><div><button class="link-btn" style="padding:0" data-night="${esc(ev.id)}">${esc(ev.name || 'This night')} ›</button></div></div>` : ''}
      </div>
      ${facts.length ? `<div class="section-title">${c.song ? 'Worth knowing' : 'While you were here'}</div>
        <div class="card facts">${facts.map((f) => `<div class="fact"><div class="tag">${esc(f.tag || '')}</div><strong>${esc(f.title)}</strong>${esc(f.text)} ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">Read more</a>` : ''}</div>`).join('')}</div>` : ''}
    `;
    const a = body.querySelector('audio'), p = body.querySelector('#play');
    if (a && p) {
      p.onclick = () => (a.paused ? a.play() : a.pause());
      a.onplay = () => (p.innerHTML = ICON.pause);
      a.onpause = a.onended = () => (p.innerHTML = ICON.play);
    }
  }

  function openCapture(id, from) {
    returnTo = from || currentView;
    go('capture');
    renderCapture(id);
  }

  async function renderNights() {
    const [events, caps] = await Promise.all([DB.all('events'), DB.all('captures')]);
    const list = $('#nights-list');
    events.sort((a, b) => b.start - a.start);
    $('#nights-empty').hidden = events.length > 0;
    freeURLs();
    list.innerHTML = events.map((e) => {
      const mine = caps.filter((c) => c.eventId === e.id).sort((a, b) => a.ts - b.ts);
      const songs = mine.filter((c) => c.song).length;
      const cover = mine.find((c) => c.photo);
      return `<button class="night-card" data-night="${esc(e.id)}">
        <div class="cover" style="${cover ? `background-image:url('${blobURL(cover.photo)}')` : ''}"></div>
        <div><h3>${esc(e.name || e.venueName || 'A night out')}</h3>
          <div class="meta">${esc(fmtDate(e.start))}${e.area ? ' · ' + esc(e.area) : ''}</div>
          <div class="pills"><span class="pill">${mine.length} photo${mine.length === 1 ? '' : 's'}</span>${songs ? `<span class="pill hot">♪ ${songs} song${songs === 1 ? '' : 's'}</span>` : ''}</div>
        </div></button>`;
    }).join('');
  }

  async function renderNight(id) {
    const ev = await DB.get('events', id);
    if (!ev) { go('nights'); return; }
    openNightId = id;
    const caps = await nightCaptures(id);
    const songs = [];
    caps.forEach((c) => { if (c.song && !songs.some((s) => s.song.title === c.song.title && s.song.artist === c.song.artist)) songs.push(c); });
    const span = ev.end - ev.start > 60000 ? `${fmtTime(ev.start)} – ${fmtTime(ev.end)}` : fmtTime(ev.start);
    const nameInput = $('#night-body .night-name');
    if (nameInput && document.activeElement === nameInput) return; // user is typing
    freeURLs();
    $('#night-body').innerHTML = `
      <div class="night-hero">
        <input class="night-name" value="${esc(ev.name || ev.venueName || 'A night out')}" aria-label="Night name" enterkeyhint="done">
        <div class="night-sub">${esc(fmtDate(ev.start))} · ${esc(span)}${ev.venueName ? '<br>' + esc(ev.venueName) : ''}${ev.area ? ', ' + esc(ev.area) : ''}</div>
      </div>
      <div class="section-title">Setlist · ${songs.length} song${songs.length === 1 ? '' : 's'}</div>
      ${songs.length ? `<ul class="setlist">${songs.map((c) => `
        <li><div class="art" style="${c.song.cover ? `background-image:url('${esc(c.song.cover)}')` : ''}"></div>
          <div><div class="t">${esc(c.song.title)}</div><div class="a">${esc(c.song.artist)}</div></div>
          <a class="time" href="${esc(c.song.links.all || c.song.links.youtube)}" target="_blank" rel="noopener">${esc(fmtTime(c.ts))} ›</a></li>`).join('')}</ul>`
        : '<p class="fine">No songs identified yet on this night.</p>'}
      <div class="section-title">Photos · ${caps.length}</div>
      <div class="grid">${caps.map((c) => `<button data-cap="${esc(c.id)}" style="background-image:url('${blobURL(c.photo)}')" aria-label="Photo at ${esc(fmtTime(c.ts))}">${c.song ? '<span class="note">♪</span>' : ''}</button>`).join('')}</div>
    `;
    const inp = $('#night-body .night-name');
    const saveName = async () => {
      const e2 = await DB.get('events', id);
      const v = inp.value.trim();
      if (e2 && v && v !== e2.name) { e2.name = v; e2.autoName = false; await DB.put('events', e2); toast('Night renamed'); }
    };
    inp.addEventListener('change', saveName);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  }

  function openNight(id) { go('night'); renderNight(id); }

  async function shareNight() {
    const ev = await DB.get('events', openNightId);
    if (!ev) return;
    const caps = await nightCaptures(ev.id);
    const lines = caps.filter((c) => c.song).map((c) => `${fmtTime(c.ts)}  ${c.song.title} — ${c.song.artist}${c.song.links.all ? '  ' + c.song.links.all : ''}`);
    const text = `${ev.name || ev.venueName}\n${fmtDate(ev.start)}${ev.venueName ? ' · ' + ev.venueName : ''}\n\n${lines.length ? lines.join('\n') : 'No songs identified'}\n\nCaptured with Encore`;
    const firstPhoto = caps.find((c) => c.photo);
    try {
      const files = firstPhoto ? [new File([firstPhoto.photo], 'encore.jpg', { type: 'image/jpeg' })] : [];
      if (navigator.canShare && files.length && navigator.canShare({ files })) await navigator.share({ title: ev.name, text, files });
      else if (navigator.share) await navigator.share({ title: ev.name, text });
      else { await navigator.clipboard.writeText(text); toast('Setlist copied'); }
    } catch (e) { if (e.name !== 'AbortError') toast('Could not share'); }
  }

  function renderSettings() {
    $('#set-key').value = Settings.key;
    $('#set-secs').value = String(Settings.secs);
    $('#set-proxy').value = Settings.proxy;
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((e) => {
        $('#storage-info').textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB on this phone.`;
      });
    }
  }

  // ---------- wiring ----------
  $('#btn-start').onclick = startCamera;
  $('#btn-shutter').onclick = shoot;
  $('#btn-flip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };
  $('#btn-settings').onclick = () => go('settings');
  $('#venue-chip').onclick = () => { chipLookupAt = 0; updateChip(); };
  $('#btn-last').onclick = () => { const id = $('#btn-last').dataset.id; if (id) openCapture(id, 'camera'); };
  $('#btn-capture-back').onclick = () => { if (returnTo === 'night' && openNightId) openNight(openNightId); else go(returnTo); };
  $('#btn-share-night').onclick = shareNight;
  $('#btn-delete').onclick = async () => {
    if (!openCaptureId || !confirm('Delete this photo and its sound?')) return;
    const c = await DB.get('captures', openCaptureId);
    await DB.del('captures', openCaptureId);
    if (c && c.eventId) {
      const rest = await nightCaptures(c.eventId);
      if (!rest.length) await DB.del('events', c.eventId);
      else {
        const ev = await DB.get('events', c.eventId);
        ev.start = rest[0].ts; ev.end = rest[rest.length - 1].ts;
        await DB.put('events', ev);
        await autoNameNight(c.eventId);
      }
    }
    toast('Deleted');
    if (returnTo === 'night' && openNightId && (await DB.get('events', openNightId))) openNight(openNightId);
    else go(returnTo === 'night' ? 'nights' : returnTo);
  };
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-night]');
    if (n) { openNight(n.dataset.night); return; }
    const c = e.target.closest('[data-cap]');
    if (c) openCapture(c.dataset.cap, 'night');
  });
  $('#settings-form').onsubmit = (e) => {
    e.preventDefault();
    lsSet('encore.key', $('#set-key').value.trim());
    lsSet('encore.secs', $('#set-secs').value);
    lsSet('encore.proxy', $('#set-proxy').value.trim());
    toast('Saved');
    retryAll();
    go('camera');
  };
  $('#btn-retry').onclick = async () => {
    const n = await retryAll();
    toast(n ? `Retried ${n} photo${n === 1 ? '' : 's'}` : 'Everything is up to date');
  };
  window.addEventListener('online', () => retryAll());
  document.addEventListener('visibilitychange', () => {
    // iOS stops the camera when the app is backgrounded; bring it back on return.
    if (document.visibilityState === 'visible' && currentView === 'camera' && lsGet('encore.started', '') && (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended'))) startCamera();
  });

  // ---------- boot ----------
  (async () => {
    await DB.open();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    refreshLastThumb();
    if (lsGet('encore.started', '')) startCamera();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    setTimeout(retryAll, 3000);
  })();

  // exposed for testing
  window.__encore = { DB, enrich, retryAll };
})();
