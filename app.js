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
    const playButton = $(`#${prefix}-play`);
    const seek = $(`#${prefix}-seek`);
    const speed = $(`#${prefix}-speed`);
    const error = $(`#${prefix}-error`);
    const picker = $(`#${pickerId}`);
    const clock = $(`#${prefix}-time`);
    const useFetch = /^https?:$/.test(window.location.protocol);
    let selected = items[0];
    let duration = selected.duration;
    let objectURLs = [];
    let prepared = false;
    let wantedPlay = false;
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
    function setState(next,progress = '0%') {
      phase = next;
      element.dataset.playbackState = next;
      const busy = ['loading','buffering','seeking'].includes(next);
      playButton.disabled = false;
      playButton.setAttribute('aria-busy',String(busy));
      playButton.setAttribute('aria-pressed',String(wantedPlay));
      if(next === 'playing') playButton.textContent = 'Pause both';
      else if(next === 'loading') playButton.textContent = `Loading ${progress} · Cancel`;
      else if(next === 'buffering') playButton.textContent = 'Buffering… Cancel';
      else if(next === 'seeking') playButton.textContent = 'Seeking… Cancel';
      else playButton.textContent = 'Play both';
    }
    function stopPlayers() {
      videos.forEach((video) => { video.pause(); video.playbackRate = rate(); });
    }
    function cancelOperation() {
      requestId++;
      operation?.abort();
      operation = undefined;
      window.clearInterval(syncTimer);
      syncTimer = undefined;
      stopPlayers();
    }
    function updateTime(position = pendingPosition ?? ours.currentTime ?? 0) {
      if(scrubbing) return;
      seek.value = Math.min(position,duration);
      clock.textContent = `${time(position)} / ${time(Math.ceil(duration))}`;
    }
    function pause() {
      wantedPlay = false;
      scrubbing = false;
      scrubResume = false;
      // Aborting also cancels both streamed HTTP downloads. Completed Blob
      // sources remain available for seeking and resuming the current scene.
      cancelOperation();
      setState('idle');
      updateTime();
    }
    function waitFor(condition,signal) {
      return new Promise((resolve,reject) => {
        if(signal.aborted) { reject(new DOMException('Cancelled','AbortError')); return; }
        const events = ['loadedmetadata','loadeddata','canplay','seeked','durationchange','error'];
        const abort = () => finish(new DOMException('Cancelled','AbortError'));
        const interval = window.setInterval(check,100);
        const timer = window.setTimeout(() => finish(new Error('decode-timeout')),30000);
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
    function prepare() {
      // Posters and source identities are sufficient before interaction. Do
      // not issue even metadata requests that compete with visible videos.
      videos.forEach((video,index) => {
        video.dataset.source = index === 0 ? selected.baseline : selected.ours;
        if(!prepared) video.preload = 'none';
      });
    }
    async function acquireSources(signal,request) {
      if(prepared) {
        if(videos.some((video) => video.error)) videos.forEach((video) => video.load());
        return;
      }
      if(useFetch) {
        const loaded = [0,0];
        const totals = [0,0];
        function showProgress() {
          if(!active(request)) return;
          const bytes = loaded[0] + loaded[1];
          const progress = totals.every((total) => total > 0)
            ? `${Math.min(100,Math.floor(100 * bytes / (totals[0] + totals[1])))}%`
            : `${(bytes / 1048576).toFixed(1)} MB`;
          setState('loading',progress);
        }
        async function download(url,index) {
          const response = await fetch(url,{signal});
          if(!response.ok) throw new Error('download');
          totals[index] = Number(response.headers.get('Content-Length')) || 0;
          showProgress();
          if(!response.body?.getReader) {
            const blob = await response.blob();
            loaded[index] = blob.size;
            totals[index] = blob.size;
            showProgress();
            return blob;
          }
          const reader = response.body.getReader();
          const chunks = [];
          try {
            while(true) {
              const {done,value} = await reader.read();
              if(done) break;
              chunks.push(value);
              loaded[index] += value.byteLength;
              showProgress();
            }
          } finally {
            reader.releaseLock();
          }
          if(!loaded[index]) throw new Error('empty-video');
          return new Blob(chunks,{type:response.headers.get('Content-Type') || 'video/mp4'});
        }
        setState('loading');
        // No fixed download deadline: a slow connection may keep making
        // progress, and the visitor can cancel at any time.
        const blobs = await Promise.all([download(selected.baseline,0),download(selected.ours,1)]);
        if(!active(request) || signal.aborted) return;
        objectURLs = blobs.map((blob) => URL.createObjectURL(blob));
      }
      if(!active(request) || signal.aborted) return;
      prepared = true;
      videos.forEach((video,index) => {
        video.muted = true;
        video.preload = 'auto';
        video.src = useFetch ? objectURLs[index] : video.dataset.source;
        video.load();
      });
    }
    function announcePlayback() {
      document.dispatchEvent(new CustomEvent('hf:playback-request',{detail:{owner:element}}));
    }
    async function begin(position,autoplay,reason = 'loading',announce = false) {
      cancelOperation();
      const request = requestId;
      operation = new AbortController();
      const signal = operation.signal;
      wantedPlay = autoplay;
      scrubbing = false;
      scrubResume = false;
      if(typeof position === 'number') pendingPosition = Math.max(0,Math.min(position,duration));
      error.hidden = true;
      setState(prepared ? (autoplay ? reason : 'seeking') : 'loading');
      if(announce) announcePlayback();
      try {
        if(document.hidden) { pause(); return; }
        await acquireSources(signal,request);
        if(!active(request)) return;
        await waitFor(() => videos.every((video) => video.readyState >= 2),signal);
        if(!active(request)) return;
        duration = Math.min(selected.duration,...videos.map((video) => Number.isFinite(video.duration) ? video.duration : selected.duration));
        seek.max = duration;
        let destination = pendingPosition;
        if(destination === null && (videos.some((video) => video.ended) || ours.currentTime >= duration - 0.08)) destination = 0;
        if(destination !== null) {
          destination = Math.max(0,Math.min(destination,duration - 0.02));
          videos.forEach((video) => { if(Math.abs(video.currentTime - destination) > 0.025) video.currentTime = destination; });
        }
        pendingPosition = null;
        setState(autoplay ? 'buffering' : 'seeking');
        await waitFor(() => videos.every((video) => !video.seeking && (video.readyState >= (autoplay ? 3 : 2) ||
          (Math.min(duration,video.duration) - video.currentTime <= 0.1 && video.readyState >= 2))),signal);
        if(!active(request)) return;
        if(!autoplay) { setState('idle'); updateTime(); return; }
        videos.forEach((video) => { video.playbackRate = rate(); });
        await Promise.all(videos.map((video) => video.play()));
        if(!active(request) || !wantedPlay) return;
        setState('playing');
        syncTimer = window.setInterval(synchronize,250);
      } catch (problem) {
        if(!active(request) || signal.aborted) return;
        pause();
        error.textContent = problem.message === 'decode-timeout'
          ? 'The videos could not start. Please try again or choose another scene.'
          : 'The videos could not be loaded. Please try again when your connection is ready.';
        error.hidden = false;
      }
    }
    function play(position) { return begin(position,true,'loading',true); }
    function rebuffer() { if(wantedPlay && phase === 'playing') void begin(undefined,true,'buffering'); }
    function synchronize() {
      if(!wantedPlay || phase !== 'playing') return;
      if(document.hidden) { pause(); return; }
      if(videos.some((video) => video.ended || video.currentTime >= duration - 0.03)) { pause(); return; }
      if(videos.some((video) => video.seeking || video.readyState < 3)) { rebuffer(); return; }
      const drift = baseline.currentTime - ours.currentTime;
      const now = performance.now();
      if(Math.abs(drift) > 0.9 && now - lastResync > 5000) {
        lastResync = now;
        void begin(ours.currentTime,true,'buffering');
        return;
      }
      // Correct small clock drift through playback rate, not repeated seeks.
      ours.playbackRate = rate();
      baseline.playbackRate = rate() * (Math.abs(drift) < 0.05 ? 1 : 1 - Math.max(-0.06,Math.min(0.06,drift * 0.16)));
    }
    function select(index) {
      pause();
      prepared = false;
      videos.forEach((video) => { video.removeAttribute('src'); video.preload = 'none'; video.load(); });
      objectURLs.forEach((url) => URL.revokeObjectURL(url));
      objectURLs = [];
      selected = items[index];
      pendingPosition = null;
      lastResync = -Infinity;
      baseline.poster = selected.baselinePoster;
      ours.poster = selected.poster;
      duration = selected.duration;
      seek.max = duration;
      updateTime(0);
      $(`#${promptId}`).textContent = selected.prompt;
      error.hidden = true;
      picker.querySelectorAll('button').forEach((button,i) => button.setAttribute('aria-pressed',String(index===i)));
      prepare();
      if(onSelect) onSelect(selected);
    }
    picker.innerHTML = items.map((item,i) => `<button type="button" data-scene="${i}" aria-pressed="false">${escape(item.title)}</button>`).join('');
    picker.addEventListener('click', (event) => { const button = event.target.closest('[data-scene]'); if(button) select(Number(button.dataset.scene)); });
    playButton.addEventListener('click', () => wantedPlay || phase !== 'idle' ? pause() : void play());
    $(`#${prefix}-reset`).addEventListener('click', () => { pause(); pendingPosition = null; if(prepared) void begin(0,false); else updateTime(0); });
    seek.addEventListener('input', () => {
      const position = Number(seek.value);
      if(!scrubbing) {
        const resume = wantedPlay;
        pause();
        scrubbing = true;
        scrubResume = resume;
      }
      seek.value = position;
      clock.textContent = `${time(position)} / ${time(Math.ceil(duration))}`;
    });
    seek.addEventListener('change', () => {
      if(!scrubbing) return;
      const position = Number(seek.value);
      const resume = scrubResume;
      scrubbing = false;
      scrubResume = false;
      void begin(position,resume,'loading',true);
    });
    seek.addEventListener('pointercancel',pause);
    speed.addEventListener('change', () => {
      videos.forEach((video) => { video.playbackRate = rate(); });
    });
    ours.addEventListener('timeupdate', () => updateTime());
    videos.forEach((video) => {
      video.addEventListener('ended', () => { pause(); updateTime(); });
      video.addEventListener('waiting',rebuffer);
      video.addEventListener('play', () => { if(!wantedPlay) video.pause(); });
      video.addEventListener('pause', () => { if(wantedPlay && phase === 'playing') pause(); });
      video.addEventListener('error', () => {
        if(!prepared || !video.error) return;
        pause();
        error.textContent = 'This video is unavailable right now. Please try another scene or try again.';
        error.hidden = false;
      });
    });
    const observer = new IntersectionObserver((entries) => entries.forEach(({isIntersecting}) => { if(!isIntersecting) pause(); }),{threshold:0});
    observer.observe(element);
    document.addEventListener('visibilitychange', () => { if(document.hidden) pause(); });
    document.addEventListener('hf:playback-request', (event) => { if(event.detail?.owner !== element) pause(); });
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
    try { if(video.requestFullscreen) await video.requestFullscreen(); else if(video.webkitEnterFullscreen) video.webkitEnterFullscreen(); } catch (_) { /* Fullscreen may be unavailable in embedded browsers. */ }
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
