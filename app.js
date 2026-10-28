'use strict';

(() => {
  const media = window.HF_MEDIA;
  if (!media) return;
  const $ = (selector) => document.querySelector(selector);
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let previewsPaused = reducedMotion.matches;
  const previewButton = $('#preview-toggle');
  const previewEntries = [
    {item:media.short.find((item) => item.id.includes('glacial_cave')) || media.short[0], label:'15-second generation', target:'#comparisons'},
    {item:media.long[0], label:'Minute-long continuity', target:'#long-videos'},
    {item:media.heroWorld, label:'Out-of-sight evolution', target:'#world-models'}
  ];
  $('#hero-reel').innerHTML = previewEntries.map(({item,label,target}) => `<div class="reel-item"><video muted loop playsinline preload="none" poster="${escape(item.poster)}" data-preview-src="${escape(item.src || item.ours)}" aria-label="${escape(item.title)} preview"></video><a href="${target}">${label}<span aria-hidden="true">↗</span></a></div>`).join('');
  const previews = [...document.querySelectorAll('[data-preview-src]')];
  function setPreviewButton() {
    previewButton.innerHTML = previewsPaused ? 'Play previews <span aria-hidden="true">▷</span>' : 'Pause previews <span aria-hidden="true">Ⅱ</span>';
    previewButton.setAttribute('aria-pressed', String(previewsPaused));
  }
  function updatePreview(video) {
    if (!previewsPaused && video.dataset.visible === 'true' && !document.hidden) {
      if (!video.getAttribute('src')) { video.src = video.dataset.previewSrc; video.muted = true; }
      video.play().catch(() => {});
    } else video.pause();
  }
  const previewObserver = new IntersectionObserver((entries) => {
    entries.forEach(({target,isIntersecting}) => { target.dataset.visible = String(isIntersecting); updatePreview(target); });
  }, {threshold:0.2});
  previews.forEach((video) => previewObserver.observe(video));
  previewButton.addEventListener('click', () => { previewsPaused = !previewsPaused; setPreviewButton(); previews.forEach(updatePreview); });
  reducedMotion.addEventListener('change', ({matches}) => { if(matches) { previewsPaused = true; setPreviewButton(); previews.forEach(updatePreview); } });
  setPreviewButton();

  $('#long-gallery').innerHTML = media.long.map((item) => `<article class="video-card"><video controls muted playsinline preload="none" poster="${escape(item.poster)}" src="${escape(item.src)}" aria-label="${escape(item.title)} — minute-long generation"></video><div class="card-caption"><h3>${escape(item.title)}</h3><span class="card-duration">${time(Math.ceil(item.duration))}</span></div><details><summary>View prompt</summary><p>${escape(item.prompt)}</p></details></article>`).join('');
  const longVideos = [...document.querySelectorAll('#long-gallery video')];
  $('#long-speed').addEventListener('change', (event) => longVideos.forEach((video) => { video.playbackRate = Number(event.target.value); }));

  function createComparison({items,baselineId,oursId,prefix,pickerId,promptId,onSelect}) {
    const baseline = $(`#${baselineId}`);
    const ours = $(`#${oursId}`);
    const videos = [baseline,ours];
    const playButton = $(`#${prefix}-play`);
    const seek = $(`#${prefix}-seek`);
    const speed = $(`#${prefix}-speed`);
    const error = $(`#${prefix}-error`);
    const picker = $(`#${pickerId}`);
    let playing = false;
    let requestId = 0;
    let duration = items[0].duration;

    function pause() {
      requestId++;
      playing = false;
      videos.forEach((video) => video.pause());
      playButton.textContent = 'Play both';
      playButton.disabled = false;
    }
    function updateTime() {
      seek.value = ours.currentTime || 0;
      $(`#${prefix}-time`).textContent = `${time(ours.currentTime || 0)} / ${time(Math.ceil(duration))}`;
    }
    function metadataReady(video) {
      if(video.readyState >= 1) return Promise.resolve();
      return new Promise((resolve,reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('Video metadata unavailable')); };
        const timer = window.setTimeout(fail,20000);
        function cleanup() {
          window.clearTimeout(timer);
          video.removeEventListener('loadedmetadata',done);
          video.removeEventListener('error',fail);
        }
        video.addEventListener('loadedmetadata',done,{once:true});
        video.addEventListener('error',fail,{once:true});
      });
    }
    async function play(position) {
      const request = ++requestId;
      error.hidden = true;
      playButton.disabled = true;
      try {
        await Promise.all(videos.map(metadataReady));
        if(request !== requestId) return;
        if(typeof position === 'number') videos.forEach((video) => { video.currentTime = position; });
        else if(ours.ended || ours.currentTime >= duration - 0.1) videos.forEach((video) => { video.currentTime = 0; });
        baseline.currentTime = ours.currentTime;
        await Promise.all(videos.map((video) => video.play()));
        if(request !== requestId) return;
        playing = true;
        playButton.textContent = 'Pause both';
      } catch (_) {
        if(request !== requestId) return;
        pause();
        error.textContent = 'Playback could not start. Please try Play both again.';
        error.hidden = false;
      } finally {
        if(request === requestId) playButton.disabled = false;
      }
    }
    function select(index) {
      pause();
      const item = items[index];
      baseline.poster = item.baselinePoster;
      ours.poster = item.poster;
      baseline.src = item.baseline;
      ours.src = item.ours;
      duration = item.duration;
      videos.forEach((video) => { video.load(); video.playbackRate = Number(speed.value); });
      seek.max = duration;
      seek.value = 0;
      $(`#${promptId}`).textContent = item.prompt;
      $(`#${prefix}-time`).textContent = `0:00 / ${time(Math.ceil(duration))}`;
      error.hidden = true;
      picker.querySelectorAll('button').forEach((button,i) => button.setAttribute('aria-pressed',String(index===i)));
      if(onSelect) onSelect(item);
    }
    picker.innerHTML = items.map((item,i) => `<button type="button" data-scene="${i}" aria-pressed="false">${escape(item.title)}</button>`).join('');
    picker.addEventListener('click', (event) => { const button = event.target.closest('[data-scene]'); if(button) select(Number(button.dataset.scene)); });
    playButton.addEventListener('click', () => playing ? pause() : play());
    $(`#${prefix}-reset`).addEventListener('click', () => { pause(); videos.forEach((video) => { video.currentTime = 0; }); updateTime(); });
    seek.addEventListener('input', () => { const position = Number(seek.value); videos.forEach((video) => { video.currentTime = position; }); updateTime(); });
    speed.addEventListener('change', () => videos.forEach((video) => { video.playbackRate = Number(speed.value); }));
    ours.addEventListener('timeupdate', () => {
      updateTime();
      if(playing && !baseline.seeking && !ours.seeking && Math.abs(baseline.currentTime - ours.currentTime) > 0.16) baseline.currentTime = ours.currentTime;
    });
    videos.forEach((video) => {
      video.addEventListener('ended', () => { pause(); updateTime(); });
      video.addEventListener('error', () => {
        pause();
        error.textContent = 'This video could not be loaded. Check that the assets folder is included with the page.';
        error.hidden = false;
      });
    });
    const observer = new IntersectionObserver((entries) => entries.forEach(({isIntersecting}) => { if(!isIntersecting) pause(); }),{threshold:0});
    observer.observe(ours);
    select(0);
    return {pause,play};
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
