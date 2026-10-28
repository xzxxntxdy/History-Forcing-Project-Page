'use strict';

(() => {
  const media = window.HF_MEDIA;
  if (!media) return;
  const $ = (selector) => document.querySelector(selector);
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  let previewsPaused = reducedMotion.matches || Boolean(connection?.saveData) || /(^|-)2g$/.test(connection?.effectiveType || '');
  let activeContent = null;
  const previewButton = $('#preview-toggle');
  const previewEntries = [
    {item:media.short.find((item) => item.id.includes('glacial_cave')) || media.short[0], label:'15-second generation', target:'#comparisons'},
    {item:media.long[0], label:'Minute-long continuity', target:'#long-videos'},
    {item:media.heroWorld, label:'Out-of-sight evolution', target:'#world-models'}
  ];
  $('#hero-reel').innerHTML = previewEntries.map(({item,label,target}) => `<div class="reel-item"><video muted loop playsinline preload="none" poster="${escape(item.poster)}" data-preview-src="${escape(item.preview || item.src || item.ours)}" aria-label="${escape(item.title)} preview"></video><a href="${target}">${label}<span aria-hidden="true">↗</span></a></div>`).join('');
  const previews = [...document.querySelectorAll('[data-preview-src]')];
  function setPreviewButton() {
    previewButton.innerHTML = previewsPaused ? 'Play previews <span aria-hidden="true">▷</span>' : 'Pause previews <span aria-hidden="true">Ⅱ</span>';
    previewButton.setAttribute('aria-pressed', String(previewsPaused));
  }
  function updatePreview(video) {
    const activeRect = activeContent?.getBoundingClientRect();
    const contentInView = activeRect && activeRect.bottom > 0 && activeRect.top < window.innerHeight;
    if (!previewsPaused && video.dataset.visible === 'true' && !document.hidden && !contentInView) {
      if (!video.getAttribute('src')) { video.src = video.dataset.previewSrc; video.muted = true; }
      video.play().catch(() => {});
    } else {
      video.pause();
      // Stop background transfers as well as decoding; small previews can use the HTTP cache on return.
      if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
    }
  }
  const previewObserver = new IntersectionObserver((entries) => {
    entries.forEach(({target,isIntersecting}) => { target.dataset.visible = String(isIntersecting); updatePreview(target); });
  }, {threshold:0.2});
  previews.forEach((video) => previewObserver.observe(video));
  previewButton.addEventListener('click', () => {
    previewsPaused = !previewsPaused;
    if (!previewsPaused) document.dispatchEvent(new CustomEvent('hf:playback-request', {detail:{owner:$('#hero-reel')}}));
    setPreviewButton(); previews.forEach(updatePreview);
  });
  reducedMotion.addEventListener('change', ({matches}) => { if(matches) { previewsPaused = true; setPreviewButton(); previews.forEach(updatePreview); } });
  setPreviewButton();

  $('#long-gallery').innerHTML = media.long.map((item) => `<article class="video-card"><video controls muted playsinline preload="none" poster="${escape(item.poster)}" src="${escape(item.src)}" aria-label="${escape(item.title)} — minute-long generation"></video><div class="card-caption"><h3>${escape(item.title)}</h3><span class="card-duration">${time(Math.ceil(item.duration))}</span></div><details><summary>View prompt</summary><p>${escape(item.prompt)}</p></details></article>`).join('');
  const longVideos = [...document.querySelectorAll('#long-gallery video')];
  longVideos.forEach((video) => video.addEventListener('play', () => {
    if (video.paused) return;
    document.dispatchEvent(new CustomEvent('hf:playback-request', {detail:{owner:video}}));
  }));
  document.addEventListener('hf:playback-request', ({detail:{owner}}) => {
    activeContent = owner === $('#hero-reel') ? null : owner;
    longVideos.forEach((video) => { if (video !== owner) video.pause(); });
    previews.forEach(updatePreview);
  });
  $('#long-speed').addEventListener('change', (event) => longVideos.forEach((video) => { video.playbackRate = Number(event.target.value); }));

  function createComparison({items,baselineId,oursId,prefix,pickerId,promptId,onSelect}) {
    const baseline = $(`#${baselineId}`);
    const ours = $(`#${oursId}`);
    const videos = [baseline,ours];
    const element = ours.closest('.paired-videos') || ours;
    const covers = videos.map((video) => {
      let viewport = video.closest('.comparison-viewport');
      if(!viewport) {
        viewport = document.createElement('div');
        viewport.className = 'comparison-viewport';
        video.before(viewport);
        viewport.append(video);
      }
      const cover = document.createElement('img');
      cover.className = 'comparison-cover';
      cover.alt = '';
      cover.setAttribute('aria-hidden','true');
      cover.draggable = false;
      viewport.append(cover);
      return cover;
    });
    const fullscreenButtons = [...element.querySelectorAll('[data-fullscreen]')];
    const playButton = $(`#${prefix}-play`);
    const seek = $(`#${prefix}-seek`);
    const speed = $(`#${prefix}-speed`);
    const error = $(`#${prefix}-error`);
    const picker = $(`#${pickerId}`);
    const clock = $(`#${prefix}-time`);
    let selected = items[0];
    let duration = selected.duration;
    let prepared = false;
    let nearViewport = false;
    let expectedSources = [];
    let wantedPlay = false;
    let waitingFor = null;
    let startupPending = true;
    let gateStage = 'idle';
    let gateTarget = 0;
    let phase = 'idle';
    let requestId = 0;
    let operation;
    let syncTimer;
    let pendingPosition = null;
    let scrubbing = false;
    let scrubResume = false;
    let lastResync = -Infinity;

    const rate = () => Number(speed.value) || 1;
    const active = (request) => request === requestId && !operation?.signal.aborted;
    const matchesSource = (video) => video.currentSrc === expectedSources[videos.indexOf(video)];
    function sourceURLs() {
      return [selected.baselineWeb || selected.baseline,selected.oursWeb || selected.ours];
    }
    function coverAt(position) {
      startupPending = true;
      gateTarget = Math.max(0,Math.min(position,duration));
      element.dataset.startupPending = 'true';
      element.dataset.startupTarget = String(gateTarget);
      videos.forEach((video) => { if(video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.(); });
      fullscreenButtons.forEach((button) => { button.disabled = true; button.setAttribute('aria-disabled','true'); });
      updateTime();
    }
    function reveal(request) {
      if(!active(request) || !startupPending) return;
      startupPending = false;
      gateStage = 'idle';
      pendingPosition = null;
      element.dataset.startupPending = 'false';
      fullscreenButtons.forEach((button) => { button.disabled = false; button.setAttribute('aria-disabled','false'); });
      lastResync = performance.now();
      updateTime();
    }
    function setState(next) {
      phase = next;
      element.dataset.playbackState = next;
      playButton.disabled = false;
      playButton.setAttribute('aria-busy',String(['loading','buffering','seeking'].includes(next)));
      playButton.setAttribute('aria-pressed',String(wantedPlay));
      playButton.textContent = next === 'playing' ? 'Pause both'
        : next === 'loading' ? 'Loading\u2026 Cancel'
        : next === 'buffering' ? 'Buffering\u2026 Cancel'
        : next === 'seeking' ? 'Seeking\u2026 Cancel' : 'Play both';
    }
    function updateTime(position = pendingPosition ?? ours.currentTime ?? 0) {
      if(scrubbing) return;
      if(startupPending) position = gateTarget;
      seek.value = Math.min(position,duration);
      clock.textContent = `${time(position)} / ${time(Math.ceil(duration))}`;
    }
    function stopPlayers() {
      videos.forEach((video) => { video.pause(); video.playbackRate = rate(); });
    }
    function cancelOperation() {
      requestId++;
      operation?.abort();
      operation = undefined;
      waitingFor = null;
      gateStage = 'idle';
      window.clearInterval(syncTimer);
      syncTimer = undefined;
      stopPlayers();
    }
    function unload() {
      prepared = false;
      videos.forEach((video) => { video.removeAttribute('src'); video.preload = 'none'; video.load(); });
    }
    function pause({release = false} = {}) {
      const downloading = release && prepared && videos.some((video) => video.networkState === 2);
      const position = startupPending ? gateTarget : pendingPosition ?? ours.currentTime ?? 0;
      wantedPlay = false;
      scrubbing = false;
      scrubResume = false;
      cancelOperation();
      if(startupPending) pendingPosition = position;
      if(downloading) { pendingPosition = position; unload(); coverAt(position); }
      setState('idle');
      updateTime();
    }
    function prepare(forPlayback = false) {
      const sources = sourceURLs();
      expectedSources = sources.map((url) => new URL(url,document.baseURI).href);
      videos.forEach((video,index) => {
        video.dataset.source = sources[index];
      });
      // Prepare identities near the viewport without a metadata-only request
      // that could stop early and require another remote Range round trip.
      if(!forPlayback) return;
      videos.forEach((video) => { video.preload = 'auto'; });
      if(prepared) {
        if(forPlayback && videos.some((video) => video.error)) videos.forEach((video) => video.load());
        return;
      }
      prepared = true;
      videos.forEach((video,index) => { video.muted = true; video.src = sources[index]; video.load(); });
    }
    function waitFor(condition,signal) {
      return new Promise((resolve,reject) => {
        if(signal.aborted) { reject(new DOMException('Cancelled','AbortError')); return; }
        const events = ['loadedmetadata','loadeddata','canplay','seeked','durationchange','error'];
        const abort = () => finish(new DOMException('Cancelled','AbortError'));
        const interval = window.setInterval(check,100);
        const timer = window.setTimeout(() => finish(new Error('timeout')),45000);
        function cleanup() {
          window.clearInterval(interval);
          window.clearTimeout(timer);
          signal.removeEventListener('abort',abort);
          videos.forEach((video) => events.forEach((event) => video.removeEventListener(event,check)));
        }
        function finish(problem) { cleanup(); if(problem) reject(problem); else resolve(); }
        function check() {
          if(signal.aborted) { abort(); return; }
          if(videos.some((video) => video.error)) { finish(new Error('media')); return; }
          if(condition()) finish();
        }
        signal.addEventListener('abort',abort,{once:true});
        videos.forEach((video) => events.forEach((event) => video.addEventListener(event,check)));
        check();
      });
    }
    function frameReady(video,request,signal,target = null,knownFrame = null) {
      return new Promise((resolve,reject) => {
        if(signal.aborted || !active(request)) { reject(new DOMException('Cancelled','AbortError')); return; }
        let settled = false;
        let frameId;
        let paintId;
        let secondPaintId;
        let captured = knownFrame;
        const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
        const abort = () => finish(new DOMException('Cancelled','AbortError'));
        const events = ['loadeddata','seeked','canplay','error'];
        const timer = window.setTimeout(() => finish(new Error('frame-timeout')),45000);
        const poll = window.setInterval(check,75);
        function cleanup() {
          window.clearTimeout(timer);
          window.clearInterval(poll);
          if(frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
          if(paintId !== undefined) cancelAnimationFrame(paintId);
          if(secondPaintId !== undefined) cancelAnimationFrame(secondPaintId);
          signal.removeEventListener('abort',abort);
          events.forEach((event) => video.removeEventListener(event,check));
        }
        function finish(problem) {
          if(settled) return;
          settled = true;
          cleanup();
          if(problem) reject(problem); else resolve(captured);
        }
        function ready() {
          const lastFrame = target !== null && video.ended && video.duration - target <= 0.1;
          return matchesSource(video) && !video.seeking && video.readyState >= 2 &&
            (target === null || Math.abs(video.currentTime - target) <= 0.04 || lastFrame);
        }
        function check() {
          if(settled) return;
          if(signal.aborted || !active(request)) { abort(); return; }
          if(video.error) { finish(new Error('media')); return; }
          if(captured && captured.source === video.currentSrc && ready() &&
             (target === null || Math.abs(captured.mediaTime - target) <= 0.15)) {
            finish();
          } else if(!hasFrameCallback && ready() && paintId === undefined) {
            // Fallback for browsers without rVFC: seek/decoded readiness plus
            // two paint opportunities, never just a currentTime assignment.
            paintId = requestAnimationFrame(() => {
              secondPaintId = requestAnimationFrame(() => {
                paintId = undefined;
                secondPaintId = undefined;
                if(!settled && ready()) {
                  captured = {mediaTime:video.currentTime,source:video.currentSrc};
                  check();
                }
              });
            });
          }
        }
        function onFrame(_,metadata) {
          frameId = undefined;
          if(settled) return;
          captured = {mediaTime:metadata.mediaTime,source:video.currentSrc};
          check();
          if(!settled) frameId = video.requestVideoFrameCallback(onFrame);
        }
        signal.addEventListener('abort',abort,{once:true});
        events.forEach((event) => video.addEventListener(event,check));
        check();
        if(!settled && hasFrameCallback) frameId = video.requestVideoFrameCallback(onFrame);
      });
    }
    function nextPaint(request,signal) {
      return new Promise((resolve,reject) => {
        if(signal.aborted || !active(request)) { reject(new DOMException('Cancelled','AbortError')); return; }
        let second;
        const abort = () => {
          cancelAnimationFrame(first);
          if(second !== undefined) cancelAnimationFrame(second);
          reject(new DOMException('Cancelled','AbortError'));
        };
        const first = requestAnimationFrame(() => {
          second = requestAnimationFrame(() => {
            signal.removeEventListener('abort',abort);
            if(active(request) && !signal.aborted) resolve(); else reject(new DOMException('Cancelled','AbortError'));
          });
        });
        signal.addEventListener('abort',abort,{once:true});
      });
    }
    function fail(request) {
      if(!active(request)) return;
      pause({release:true});
      error.textContent = 'The videos could not play. Please try again or choose another scene.';
      error.hidden = false;
    }
    function requestPlay(video,request) {
      const gatePlaying = startupPending && ['priming','starting'].includes(gateStage);
      if(!active(request) || (!wantedPlay && !gatePlaying) || document.hidden || (!startupPending && waitingFor && waitingFor !== video)) return;
      video.play().catch((problem) => {
        // Holding the other stream during buffering intentionally aborts its
        // pending play promise. It resumes from the playing event below.
        if(problem.name !== 'AbortError' && active(request) && wantedPlay) fail(request);
      });
    }
    function announcePlayback() {
      document.dispatchEvent(new CustomEvent('hf:playback-request',{detail:{owner:element}}));
    }
    async function begin(position,autoplay,announce = false) {
      let target = typeof position === 'number' ? position
        : pendingPosition ?? (startupPending ? gateTarget : ours.currentTime || 0);
      if(typeof position !== 'number' && (videos.some((video) => video.ended) || target >= duration - 0.08)) target = 0;
      cancelOperation();
      const request = requestId;
      operation = new AbortController();
      const signal = operation.signal;
      wantedPlay = autoplay;
      scrubbing = false;
      scrubResume = false;
      coverAt(target);
      pendingPosition = gateTarget;
      gateStage = 'priming';
      error.hidden = true;
      setState(autoplay ? 'loading' : 'seeking');
      if(announce) announcePlayback();
      try {
        if(document.hidden) { pause({release:true}); return; }
        prepare(true);
        function applyInitialPosition(video) {
          if(!active(request)) return;
          const end = Number.isFinite(video.duration) ? Math.min(duration,video.duration) : duration;
          const destination = Math.max(0,Math.min(gateTarget,end - 0.02));
          if(Math.abs(video.currentTime - destination) > 0.025) video.currentTime = destination;
        }
        videos.forEach((video) => {
          if(video.readyState >= 1) applyInitialPosition(video);
          else video.addEventListener('loadedmetadata',() => applyInitialPosition(video),{once:true,signal});
        });
        // Keep both downloads active behind opaque covers, including when one
        // stream responds much earlier or finishes before the other starts.
        const firstFrames = Promise.all(videos.map((video) => frameReady(video,request,signal)));
        videos.forEach((video) => { video.playbackRate = rate(); requestPlay(video,request); });
        let submitted = await firstFrames;
        if(!active(request)) return;
        duration = Math.min(selected.duration,...videos.map((video) => Number.isFinite(video.duration) ? video.duration : selected.duration));
        seek.max = duration;
        coverAt(Math.max(0,Math.min(gateTarget,duration - 0.02)));
        pendingPosition = gateTarget;
        while(active(request)) {
          gateStage = 'aligning';
          stopPlayers();
          const alignedFrames = videos.map((video,index) => {
            const frame = submitted[index];
            // A stream that advanced must submit its sought frame again.
            const lastFrame = video.ended && video.duration - gateTarget <= 0.1 &&
              Math.abs(frame.mediaTime - gateTarget) <= 0.1;
            const reusable = lastFrame || (Math.abs(video.currentTime - frame.mediaTime) < 0.025 &&
              Math.abs(frame.mediaTime - gateTarget) <= 0.04) ? frame : null;
            const ready = frameReady(video,request,signal,gateTarget,reusable);
            video.currentTime = gateTarget;
            return ready;
          });
          submitted = await Promise.all(alignedFrames);
          const atEnd = gateTarget >= duration - 0.1;
          await waitFor(() => videos.every((video) => !video.seeking && video.readyState >= (autoplay && !atEnd ? 3 : 2)),signal);
          await nextPaint(request,signal);
          if(!active(request)) return;
          if(!autoplay || atEnd) {
            wantedPlay = false;
            reveal(request);
            setState('idle');
            return;
          }
          gateStage = 'starting';
          // Target frames are already submitted. The native play promises
          // confirm both starts without waiting for a nonexistent next frame
          // when the requested position is the clip's last frame.
          await Promise.all(videos.map((video) => video.play()));
          await waitFor(() => videos.every((video) => !video.seeking && (!video.paused || video.ended) && video.readyState >= 3),signal);
          await nextPaint(request,signal);
          if(!active(request) || !wantedPlay) return;
          // A delayed play promise must not expose a new lead or skip the
          // requested opening. Any retry stays behind the same opaque covers.
          const positions = videos.map((video) => video.currentTime);
          if(Math.abs(positions[0] - positions[1]) <= 0.12 &&
             positions.every((position) => Math.abs(position - gateTarget) <= 0.3)) break;
        }
        if(!active(request)) return;
        // This is the only reveal path. No initialization rewind runs after it.
        reveal(request);
        if(videos.some((video) => video.ended)) { pause(); return; }
        setState('playing');
        syncTimer = window.setInterval(synchronize,250);
      } catch (_) {
        if(active(request) && !signal.aborted) fail(request);
      }
    }
    function play(position) { return begin(position,true,true); }
    function synchronize() {
      if(startupPending || !wantedPlay || waitingFor || phase !== 'playing') return;
      if(document.hidden) { pause({release:true}); return; }
      if(videos.some((video) => video.ended || video.currentTime >= duration - 0.03)) { pause(); return; }
      if(videos.some((video) => video.paused || video.seeking || video.readyState < 3)) return;
      const drift = baseline.currentTime - ours.currentTime;
      const now = performance.now();
      if(Math.abs(drift) > 0.9 && now - lastResync > 5000) {
        lastResync = now;
        baseline.currentTime = ours.currentTime;
        return;
      }
      ours.playbackRate = rate();
      baseline.playbackRate = rate() * (Math.abs(drift) < 0.05 ? 1 : 1 - Math.max(-0.06,Math.min(0.06,drift * 0.16)));
    }
    function select(index,loadNow = false) {
      pause();
      unload();
      selected = items[index];
      pendingPosition = null;
      lastResync = -Infinity;
      baseline.poster = selected.baselinePoster;
      ours.poster = selected.poster;
      covers[0].src = selected.baselinePoster;
      covers[1].src = selected.poster;
      duration = selected.duration;
      seek.max = duration;
      coverAt(0);
      updateTime(0);
      $(`#${promptId}`).textContent = selected.prompt;
      error.hidden = true;
      const sources = sourceURLs();
      videos.forEach((video,i) => { video.dataset.source = sources[i]; });
      picker.querySelectorAll('button').forEach((button,i) => button.setAttribute('aria-pressed',String(index===i)));
      if(onSelect) onSelect(selected);
      if(nearViewport || loadNow) prepare();
    }
    picker.innerHTML = items.map((item,i) => `<button type="button" data-scene="${i}" aria-pressed="false">${escape(item.title)}</button>`).join('');
    picker.addEventListener('click', (event) => { const button = event.target.closest('[data-scene]'); if(button) select(Number(button.dataset.scene),true); });
    playButton.addEventListener('click', () => wantedPlay || phase !== 'idle' ? pause({release:phase !== 'playing'}) : void play());
    $(`#${prefix}-reset`).addEventListener('click', () => { pause(); pendingPosition = null; if(prepared) void begin(0,false); else coverAt(0); });
    seek.addEventListener('input', () => {
      const position = Number(seek.value);
      if(!scrubbing) { const resume = wantedPlay; pause(); scrubbing = true; scrubResume = resume; }
      pendingPosition = position;
      coverAt(position);
      seek.value = position;
      clock.textContent = `${time(position)} / ${time(Math.ceil(duration))}`;
    });
    seek.addEventListener('change', () => {
      if(!scrubbing) return;
      const position = Number(seek.value);
      const resume = scrubResume;
      scrubbing = false;
      scrubResume = false;
      void begin(position,resume,true);
    });
    seek.addEventListener('pointercancel',pause);
    speed.addEventListener('change', () => videos.forEach((video) => { video.playbackRate = rate(); }));
    ours.addEventListener('timeupdate', () => updateTime());
    videos.forEach((video) => {
      const peer = video === ours ? baseline : ours;
      video.addEventListener('waiting', () => {
        if(!wantedPlay || video.paused || !matchesSource(video)) return;
        if(startupPending) return;
        // Keep this stream's native play intent alive so Chrome continues
        // fetching. Only hold its peer; pausing both can stall cellular fetch.
        waitingFor = video;
        peer.pause();
        setState('buffering');
      });
      video.addEventListener('playing', () => {
        if(video.paused || !matchesSource(video)) return;
        if(startupPending) {
          if(gateStage === 'idle' || !operation || operation.signal.aborted) video.pause();
          return;
        }
        if(!wantedPlay || document.hidden) { video.pause(); return; }
        if(waitingFor && waitingFor !== video) { video.pause(); return; }
        if(waitingFor === video) { waitingFor = null; requestPlay(peer,requestId); }
        if(videos.every((item) => !item.paused && item.readyState >= 3)) setState('playing');
      });
      video.addEventListener('play', () => {
        if(!wantedPlay && !(startupPending && ['priming','starting'].includes(gateStage))) video.pause();
      });
      video.addEventListener('pause', () => {
        if(startupPending) return;
        if(wantedPlay && video.paused && (!waitingFor || waitingFor === video) && phase === 'playing') pause();
      });
      video.addEventListener('ended', () => { if(!startupPending && matchesSource(video)) { pause(); updateTime(); } });
      video.addEventListener('error', () => { if(prepared && video.error) fail(requestId); });
    });
    element.addEventListener('click', (event) => {
      if(startupPending && event.target.closest('[data-fullscreen]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },true);
    const prepareObserver = new IntersectionObserver((entries) => entries.forEach(({isIntersecting}) => {
      nearViewport = isIntersecting;
      if(isIntersecting) prepare(wantedPlay);
    }),{rootMargin:'300px 0px',threshold:0});
    prepareObserver.observe(element);
    const observer = new IntersectionObserver((entries) => entries.forEach(({isIntersecting}) => { if(!isIntersecting) pause({release:true}); }),{threshold:0});
    observer.observe(element);
    document.addEventListener('visibilitychange', () => { if(document.hidden) pause({release:true}); });
    document.addEventListener('hf:playback-request', (event) => { if(event.detail?.owner !== element) pause({release:true}); });
    select(0);
    return {pause,play,element,prepare};
  }
  const shortComparison = createComparison({
    items:media.short, baselineId:'baseline-video', oursId:'ours-video',
    prefix:'pair', pickerId:'short-picker', promptId:'short-prompt'
  });
  const worldHighlights = {
    '01_watercolor': {time:8, cue:'Watch how the watercolor marks develop while the camera looks away.'},
    '03_milk_pouring': {time:8.5, cue:'Watch the glass shape and the milk level after the camera returns.'},
    '05_sand_filling': {time:8, cue:'Watch the container and sand level as the camera returns.'}
  };
  let worldHighlight;
  const worldComparison = createComparison({
    items:media.world, baselineId:'world-baseline-video', oursId:'world-ours-video',
    prefix:'world-pair', pickerId:'world-picker', promptId:'world-prompt',
    onSelect(item) {
      $('#world-scene-title').textContent = item.title;
      worldHighlight = worldHighlights[item.id];
      $('#world-cue').textContent = worldHighlight ? worldHighlight.cue : '';
      $('#world-revisit').hidden = !worldHighlight;
      if(worldHighlight) $('#world-revisit').textContent = `Jump to revisit · ${time(worldHighlight.time)} ↗`;
    }
  });
  $('#world-revisit').addEventListener('click', () => { if(worldHighlight) worldComparison.play(worldHighlight.time); });
  document.querySelectorAll('[data-fullscreen]').forEach((button) => button.addEventListener('click', async () => {
    const video = document.getElementById(button.dataset.fullscreen);
    if(video.closest('.paired-videos')?.dataset.startupPending === 'true') return;
    const viewport = video.closest('.comparison-viewport') || video;
    try { if(viewport.requestFullscreen) await viewport.requestFullscreen(); else if(video.webkitEnterFullscreen) video.webkitEnterFullscreen(); } catch (_) { /* Fullscreen may be unavailable in embedded browsers. */ }
  }));
  const contentObserver = new IntersectionObserver((entries) => entries.forEach(({target,isIntersecting}) => { if(!isIntersecting) target.pause(); }), {threshold:0});
  longVideos.forEach((video) => contentObserver.observe(video));
  document.addEventListener('visibilitychange', () => {
    previews.forEach(updatePreview);
    if(document.hidden) { shortComparison.pause(); worldComparison.pause(); longVideos.forEach((video) => video.pause()); }
  });

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(selected) {
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute('aria-selected',String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    });
  }
  tabs.forEach((tab,index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if(event.key === 'ArrowRight') next = tabs[(index+1)%tabs.length];
      if(event.key === 'ArrowLeft') next = tabs[(index-1+tabs.length)%tabs.length];
      if(event.key === 'Home') next = tabs[0];
      if(event.key === 'End') next = tabs[tabs.length-1];
      if(next) { event.preventDefault(); selectTab(next); next.focus(); }
    });
  });

  $('#copy-citation').addEventListener('click', async () => {
    const content = $('#bibtex').textContent;
    let copied = false;
    try { await navigator.clipboard.writeText(content); copied = true; } catch (_) {
      const field = document.createElement('textarea');
      field.value = content; field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.append(field); field.select();
      copied = document.execCommand('copy'); field.remove();
    }
    if(copied) {
      $('#copy-citation').textContent = 'Copied!';
      $('#copy-status').textContent = 'BibTeX copied to clipboard.';
      window.setTimeout(() => { $('#copy-citation').textContent = 'Copy BibTeX'; }, 2000);
    } else {
      const range = document.createRange(); range.selectNodeContents($('#bibtex'));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      $('#copy-status').textContent = 'Citation selected. Press Control+C or Command+C to copy.';
      $('#copy-citation').textContent = 'Selected — press Ctrl/Cmd+C';
    }
  });
})();
