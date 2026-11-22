{
  const video = document.querySelector('#workflow-video');
  const film = video.closest('.film');
  const status = film.querySelector('.workflow-film-status');
  const filmTime = film.querySelector('.workflow-film-time');
  const fullLength = filmTime.textContent;
  const chapters = [...document.querySelectorAll('.chapter-button')].map(button => ({
    button,
    marker: button.querySelector('.chapter-marker').textContent,
    start: Number(button.dataset.start),
    end: Number(button.dataset.end),
    seek: Number(button.dataset.seek),
    label: button.querySelector('.chapter-title').textContent,
    time: button.querySelector('time').textContent,
  }));

  const poster = video.getAttribute('poster');
  const filmSource = video.querySelector('source').src;

  let pending = null;
  let current = null;
  let filmRequest = null;
  let filmUrl = null;
  let resumeAfterSwitch = false;

  function updateCurrentChapter() {
    const time = video.currentTime;
    const chapter = chapters.find(item => time >= item.start && time < item.end) ?? null;
    if (chapter === current) return;

    current?.button.removeAttribute('aria-current');
    current = chapter;
    filmTime.toggleAttribute('data-current', Boolean(current));
    if (current) {
      current.button.setAttribute('aria-current', 'true');
      filmTime.textContent = current.marker;
    } else {
      filmTime.textContent = fullLength;
    }
  }

  function setStatus(text, visible) {
    status.classList.toggle('workflow-sr-only', !visible);
    status.textContent = text;
  }

  function clearPending() {
    pending.button.removeAttribute('data-pending');
    pending = null;
  }

  function settleSeek() {
    if (!filmUrl || video.currentSrc !== filmUrl || video.seeking) return;
    updateCurrentChapter();
    if (!pending) return;

    const chapter = pending;
    clearPending();
    if (current === chapter) {
      setStatus(`已定位到 ${chapter.time} · ${chapter.label}`, false);
    } else {
      setStatus('未能定位到该段，可以再次点击章节。', true);
    }

    if (resumeAfterSwitch) {
      resumeAfterSwitch = false;
      video.play().catch(() => {});
    }
  }

  function failSeek() {
    if (!pending) return;

    clearPending();
    setStatus('短片暂时无法加载，可以再次点击章节重试。', true);
  }

  function seekToPending() {
    if (!pending || !filmUrl || video.currentSrc !== filmUrl || video.readyState < video.HAVE_METADATA) return;
    if (!Number.isFinite(video.duration) || pending.seek >= video.duration) {
      failSeek();
      return;
    }

    if (!video.seeking && video.readyState >= video.HAVE_CURRENT_DATA && Math.abs(video.currentTime - pending.seek) < 0.05) {
      settleSeek();
      return;
    }
    video.currentTime = pending.seek;
  }

  async function fetchFilm() {
    const response = await fetch(filmSource);
    if (!response.ok) throw new Error(`Could not load the film: ${response.status}`);
    return response.blob();
  }

  function requestSeekableFilm() {
    if (filmRequest) return;
    // Static media streams normally, but the origin may ignore byte ranges.
    filmRequest = fetchFilm()
      .then(film => {
        filmUrl = URL.createObjectURL(film);
        resumeAfterSwitch = !video.paused && !video.ended;
        video.removeAttribute('poster');
        video.preload = 'auto';
        video.src = filmUrl;
      })
      .catch(failSeek)
      .finally(() => { filmRequest = null; });
  }

  function restoreOriginalFilm(event) {
    if (event.target !== video || !filmUrl || video.getAttribute('src') !== filmUrl) return;
    URL.revokeObjectURL(filmUrl);
    filmUrl = null;
    resumeAfterSwitch = false;
    video.removeAttribute('src');
    if (poster) video.setAttribute('poster', poster);
    video.preload = 'none';
    video.load();
    failSeek();
  }

  function revealVideo() {
    const { top, bottom } = video.getBoundingClientRect();
    if (top < 0 || bottom > window.innerHeight) {
      video.focus({ preventScroll: true });
      film.scrollIntoView({ block: 'nearest' });
    }
  }

  for (const chapter of chapters) {
    chapter.button.addEventListener('click', () => {
      pending?.button.removeAttribute('data-pending');
      pending = chapter;
      chapter.button.setAttribute('data-pending', '');
      setStatus(`正在定位到 ${chapter.time} · ${chapter.label}`, true);
      if (filmUrl) seekToPending();
      else requestSeekableFilm();
      revealVideo();
    });
    chapter.button.disabled = false;
  }

  video.addEventListener('loadedmetadata', seekToPending);
  video.addEventListener('seeked', settleSeek);
  video.addEventListener('timeupdate', () => {
    if (!pending && !video.seeking) updateCurrentChapter();
  });
  video.addEventListener('error', restoreOriginalFilm);
}
