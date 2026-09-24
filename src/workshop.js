/* Game-native map cards; generation and persistence live in maps.js. */
(function (CF) {
  'use strict';
  const TEXT = {
    ko: { stages: '스테이지', create: '만들기', mine: '내 맵', difficulty: '난이도', advanced: '설정', length: '길이', height: '높이', spacing: '간격', coins: '코인', placement: '배치', even: '고르게', early: '앞쪽', late: '뒤쪽', generate: '다시 만들기', cancel: '취소', preview: '맵 미리보기', title: '맵 이름', gold: '금메달 시간', silver: '은메달 시간', bronze: '동메달 시간', play: '플레이', save: '저장', export: '파일로 저장', import: '불러오기', edit: '수정', remove: '삭제', undo: '되돌리기', best: '최고 기록', untitled: '내 맵', saved: '저장됨', removed: '삭제됨', cancelled: '취소됨', working: '생성 중', importing: '불러오는 중', invalid: '맵 파일을 확인해 주세요.', failed: '다시 생성해 주세요.', unsaved: '저장 실패 · 파일로 저장해 주세요.', loadError: '저장된 맵을 읽지 못했습니다.', titleError: '이름과 시간을 확인해 주세요. 금 < 은 < 동' },
    en: { stages: 'Stages', create: 'Create', mine: 'My maps', difficulty: 'Difficulty', advanced: 'Settings', length: 'Length', height: 'Height', spacing: 'Spacing', coins: 'Coins', placement: 'Placement', even: 'Even', early: 'Early', late: 'Late', generate: 'Shuffle', cancel: 'Cancel', preview: 'Map preview', title: 'Map name', gold: 'Gold time', silver: 'Silver time', bronze: 'Bronze time', play: 'Play', save: 'Save', export: 'Export file', import: 'Import', edit: 'Edit', remove: 'Delete', undo: 'Undo', best: 'Best time', untitled: 'My map', saved: 'Saved', removed: 'Deleted', cancelled: 'Cancelled', working: 'Generating', importing: 'Importing', invalid: 'Check the map file.', failed: 'Try another map.', unsaved: 'Save failed. Export a file.', loadError: 'Saved maps could not be read.', titleError: 'Check the name and times. Gold < Silver < Bronze' }
  };
  const paths = {
    stages: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    create: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7.5 7.5h.01M16.5 7.5h.01M12 12h.01M7.5 16.5h.01M16.5 16.5h.01" stroke-width="3.5"/>',
    mine: '<path d="M3 7V5a2 2 0 012-2h5l3 4h6a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>',
    advanced: '<path d="M4 7h7m5 0h4M4 17h4m5 0h7"/><circle cx="13.5" cy="7" r="2.5"/><circle cx="10.5" cy="17" r="2.5"/>',
    save: '<path d="M6 3h12v18l-6-4-6 4V3z"/>',
    export: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    import: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6z"/>',
    remove: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    undo: '<path d="m9 4-5 5 5 5M4 9h10a6 6 0 010 12"/>',
    play: '<path d="m8 4 13 8-13 8V4z" fill="currentColor"/>',
    cancel: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  const icon = key => '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[key] + '</svg>';
  function create({ getLanguage, play, best }) {
    const M = CF.maps;
    let storage;
    try { storage = localStorage; } catch { storage = { getItem() { throw Error(); }, setItem() { throw Error(); } }; }
    const library = M.library(storage);
    const stageList = document.getElementById('courseList');
    const root = document.createElement('div');
    root.className = 'workshop';
    const action = (id, key, symbol = key, cls = '') => '<button type="button" id="' + id + '" class="map-icon ' + cls + '" data-label="' + key + '">' + icon(symbol) + '</button>';
    root.innerHTML = [
      '<nav class="map-tabs">',
      ...['stages', 'create', 'mine'].map(key => '<button type="button" data-tab="' + key + '">' + icon(key) + '<span data-copy="' + key + '"></span></button>'),
      '</nav><section class="map-editor" hidden><div class="map-sheet"><header class="map-sheet-head">',
      '<label class="map-name"><span class="sr" data-copy="title"></span><input id="mapTitle" type="text" maxlength="60" required autocomplete="off"></label>',
      '<div class="map-tools">' + action('saveMap', 'save') + action('exportMap', 'export') + '</div></header>',
      '<div class="map-chart"><svg viewBox="0 0 640 210" role="img" id="mapPreview"></svg>',
      '<div class="map-loading" hidden><span class="map-spinner" aria-hidden="true"></span><output id="mapPercent">0%</output>' + action('cancelMap', 'cancel') + '</div></div>',
      '<div class="map-deck" id="mapDetails"><div class="medal-fields">',
      ...['gold', 'silver', 'bronze'].map((key, i) => '<label class="medal-chip ' + key + '"><span class="medal-mark" aria-hidden="true">' + (i + 1) + '</span><span class="sr" data-copy="' + key + '"></span><input id="medal-' + key + '" type="number" min="0.1" max="600" step="0.1" required><span class="time-unit" aria-hidden="true">s</span></label>'),
      '</div><button type="button" class="primary map-play" id="playMap">' + icon('play') + '<span data-copy="play"></span></button></div></div>',
      '<div class="map-controls"><label class="difficulty-control"><span data-copy="difficulty"></span><div class="difficulty-track"><input id="mapDifficulty" type="range" min="1" max="10" value="5"></div><output id="difficultyValue">5</output></label>',
      action('generateMap', 'generate', 'create', 'shuffle'), action('mapSettings', 'advanced'),
      '</div><div class="map-advanced" hidden></div><p class="map-status" id="mapStatus" role="status" aria-live="polite"></p></section>',
      '<section class="map-library" hidden><div class="library-tools"><div>',
      action('undoMap', 'undo'), action('cancelImport', 'cancel'),
      '<label class="map-icon import-label" data-label="import">' + icon('import') + '<input id="importMap" type="file" accept=".json,application/json"></label></div></div>',
      '<p class="map-status" id="libraryStatus" role="status" aria-live="polite"></p><div id="savedMaps" class="courses"></div>',
      '<button type="button" id="mapEmpty" class="empty-map">' + icon('plus') + '<span data-copy="create"></span></button></section>'
    ].join('');
    stageList.before(root);
    const q = selector => root.querySelector(selector);
    let lang = getLanguage(), tab = 'stages', draft = null, controller = null, removed = null, statusKey = '', libraryKey = library.error ? 'loadError' : '';
    const t = key => TEXT[lang][key] || '';
    const ranges = [['length', 12000, 60000, 1000], ['height', 300, 1800, 50], ['spacing', 800, 3200, 100], ['coins', 10, 200, 5]];
    const defaults = M.defaults();
    for (const [key, min, max, step] of ranges) {
      const label = document.createElement('label');
      label.className = 'range-label';
      label.innerHTML = '<span data-copy="' + key + '"></span><output></output><input type="range" id="map-' + key + '" min="' + min + '" max="' + max + '" step="' + step + '">';
      label.querySelector('input').value = defaults[key]; q('.map-advanced').append(label);
    }
    const placement = document.createElement('label');
    placement.className = 'placement-control';
    placement.innerHTML = '<span data-copy="placement"></span><select id="map-placement"><option value="even" data-copy="even"></option><option value="early" data-copy="early"></option><option value="late" data-copy="late"></option></select>';
    q('.map-advanced').append(placement);
    q('#mapSettings').setAttribute('aria-expanded', 'false');
    q('#mapSettings').setAttribute('aria-controls', 'mapAdvanced');
    q('.map-advanced').id = 'mapAdvanced';
    q('#undoMap').hidden = q('#cancelImport').hidden = true;
    const errors = new Set(['invalid', 'failed', 'unsaved', 'loadError', 'titleError']);
    function announce(element, key) {
      element.textContent = t(key); element.classList.toggle('sr', !errors.has(key));
    }
    function setStatus(key) {
      statusKey = key; announce(q('#mapStatus'), key);
      const saved = key === 'saved';
      q('#saveMap').classList.toggle('saved', saved);
      q('#saveMap').innerHTML = icon(saved ? 'check' : 'save');
      q('#saveMap').setAttribute('aria-label', t(saved ? 'saved' : 'save'));
      q('#saveMap').title = t(saved ? 'saved' : 'save');
    }
    function setLibrary(key) { libraryKey = key; announce(q('#libraryStatus'), key); }
    function outputs() {
      q('#difficultyValue').textContent = q('#mapDifficulty').value;
      for (const input of root.querySelectorAll('input[type="range"]')) input.style.setProperty('--fill', ((input.value - input.min) / (input.max - input.min) * 100) + '%');
      for (const [key] of ranges) q('#map-' + key).previousElementSibling.textContent = Number(q('#map-' + key).value).toLocaleString(lang);
    }
    function ready(value) {
      for (const element of root.querySelectorAll('#mapTitle, .medal-fields input, #playMap, #saveMap, #exportMap')) element.disabled = !value;
      q('.map-sheet').classList.toggle('unready', !value);
    }
    function switchTab(next, autoGenerate = true) {
      if (controller) controller.abort();
      tab = next;
      stageList.hidden = next !== 'stages';
      q('.map-editor').hidden = next !== 'create';
      q('.map-library').hidden = next !== 'mine';
      document.getElementById('menu').classList.toggle('editing-map', next !== 'stages');
      for (const button of root.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === next));
      if (next === 'mine') renderLibrary();
      if (next === 'create' && !draft && !controller && autoGenerate) generate();
    }
    function updateText() {
      lang = getLanguage();
      for (const element of root.querySelectorAll('[data-copy]')) element.textContent = t(element.dataset.copy);
      for (const element of root.querySelectorAll('[data-label]')) { element.title = t(element.dataset.label); element.setAttribute('aria-label', t(element.dataset.label)); }
      q('#importMap').setAttribute('aria-label', t('import'));
      q('nav').setAttribute('aria-label', t('stages'));
      q('#mapPreview').setAttribute('aria-label', t('preview'));
      q('#mapTitle').placeholder = t('title');
      setStatus(statusKey); setLibrary(libraryKey); outputs(); renderLibrary();
    }
    function stale() { draft = null; ready(false); setStatus(''); outputs(); }
    function busy(value) {
      for (const element of root.querySelectorAll('#mapDifficulty, .map-advanced input, .map-advanced select, #generateMap, #importMap')) element.disabled = value;
      q('.map-loading').hidden = !value || tab !== 'create';
      q('#cancelImport').hidden = !value || tab !== 'mine';
      q('#mapPercent').value = '0%';
      q('.map-chart').classList.toggle('loading', value && tab === 'create');
      if (value) ready(false);
    }
    function draw(def, svg, detailed = true) {
      const ns = 'http://www.w3.org/2000/svg';
      const node = (tag, attributes) => { const element = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value); svg.append(element); return element; };
      const course = CF.terrain.buildCourse(def);
      const xs = new Set(Array.from({ length: 161 }, (_, i) => course.finishX * i / 160));
      if (detailed) for (const item of course.items) xs.add(item.x);
      const samples = [...xs].sort((a, b) => a - b).map(x => [x, course.terrain.height(x)]);
      const coins = detailed ? course.items.map(item => [item.x, course.terrain.height(item.x) + item.lift]) : [];
      const ys = [...samples, ...coins].map(p => p[1]);
      const min = Math.min(...ys), max = Math.max(...ys);
      const px = x => 24 + x / course.finishX * 592;
      const py = y => 175 - (y - min) / (max - min || 1) * 145;
      const path = samples.map(([x, y], i) => (i ? 'L' : 'M') + px(x).toFixed(1) + ',' + py(y).toFixed(1)).join(' ');
      svg.replaceChildren();
      node('path', { d: path + ' L616,210 L24,210 Z', class: 'chart-fill' });
      node('path', { d: path, class: 'chart-line' });
      if (detailed) {
        const group = node('g', { class: 'chart-coins' });
        for (const [x, y] of coins) {
          const circle = document.createElementNS(ns, 'circle');
          circle.setAttribute('cx', px(x)); circle.setAttribute('cy', py(y)); circle.setAttribute('r', '2.7'); group.append(circle);
        }
        node('circle', { cx: px(0), cy: py(samples[0][1]), r: 6, class: 'chart-start' });
        const x = px(course.finishX), y = py(samples.at(-1)[1]);
        node('path', { d: 'M' + x + ',' + y + 'v-24h15l-4 6 4 6h-15', class: 'chart-flag' });
      }
    }
    function display(def) {
      draft = def;
      if (def.parameters) {
        q('#mapDifficulty').value = def.parameters.difficulty;
        for (const [key] of ranges) q('#map-' + key).value = def.parameters[key];
        q('#map-placement').value = def.parameters.placement;
        outputs();
      }
      q('#mapTitle').value = def.name[lang] || def.name.en;
      ['gold', 'silver', 'bronze'].forEach((key, i) => { q('#medal-' + key).value = def.medals[i]; });
      draw(def, q('#mapPreview')); ready(true); setStatus('');
    }
    function edited() {
      if (!draft) return null;
      try {
        const data = M.documentFor(draft).map;
        data.title = q('#mapTitle').value;
        data.medals = ['gold', 'silver', 'bronze'].map(key => Number(q('#medal-' + key).value));
        return M.normalize(data);
      } catch { setStatus('titleError'); return null; }
    }
    function download(def) {
      const url = URL.createObjectURL(new Blob([M.encode(def)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = def.id + '.json';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function generate() {
      if (controller) return;
      const task = new AbortController(); controller = task;
      busy(true); stale(); setStatus('working');
      const params = { difficulty: Number(q('#mapDifficulty').value), placement: q('#map-placement').value };
      for (const [key] of ranges) params[key] = Number(q('#map-' + key).value);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (task.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          await new Promise(resolve => setTimeout(resolve, 0));
          const def = M.generate(seed + attempt, params); draw(def, q('#mapPreview'));
          try {
            const report = await M.evaluate(def, { signal: task.signal, progress: n => { q('#mapPercent').value = Math.round(n * 100) + '%'; } });
            def.medals = report.medals;
            def.name = { ko: t('untitled') + ' ' + (library.maps.length + 1), en: t('untitled') + ' ' + (library.maps.length + 1) };
            display(M.normalize(M.documentFor(def).map)); return;
          } catch (error) { if (error.name === 'AbortError' || attempt === 3 || !['weak-course', 'unfinishable'].includes(error.message)) throw error; }
        }
      } catch (error) { setStatus(error.name === 'AbortError' ? 'cancelled' : 'failed'); }
      finally { controller = null; busy(false); }
    }
    function renderLibrary() {
      const list = q('#savedMaps'); list.replaceChildren();
      q('#mapEmpty').hidden = library.maps.length > 0;
      for (const [index, def] of library.maps.entries()) {
        const card = document.createElement('article'); card.className = 'saved-map';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'course';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 640 210'); svg.setAttribute('aria-hidden', 'true'); draw(def, svg, false);
        const title = document.createElement('span'); title.className = 'course-title';
        const number = document.createElement('span'); number.className = 'num'; number.textContent = String(index + 1); number.setAttribute('aria-hidden', 'true');
        const name = document.createElement('b'); name.textContent = def.name[lang] || def.name.en; title.append(number, name);
        const record = best(def);
        const foot = document.createElement('div'); foot.className = 'course-foot';
        const bestTime = document.createElement('span'); bestTime.className = 'best' + (record === null ? ' empty' : '');
        const medal = record === null ? '' : ['gold', 'silver', 'bronze'][def.medals.findIndex(limit => Math.round(record * 100) / 100 <= limit)] || '';
        bestTime.innerHTML = '<i class="dot ' + medal + '"></i>';
        bestTime.append(record === null ? '—' : record.toFixed(2) + 's'); bestTime.setAttribute('aria-label', t('best') + ' ' + (record ?? '—'));
        const gold = document.createElement('span'); gold.className = 'goal'; gold.innerHTML = '<i class="dot gold"></i>'; gold.append(def.medals[0] + 's');
        foot.append(bestTime, gold); button.append(svg, title, foot); button.addEventListener('click', () => play(def));
        const actions = document.createElement('div'); actions.className = 'saved-actions';
        for (const [key, handler] of [['edit', () => { switchTab('create', false); display(def); }], ['export', () => download(def)], ['remove', () => { removed = def; const ok = library.remove(def.id); q('#undoMap').hidden = false; setLibrary(ok ? 'removed' : 'unsaved'); renderLibrary(); }]]) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'map-icon'; b.setAttribute('aria-label', t(key)); b.title = t(key); b.innerHTML = icon(key); b.addEventListener('click', handler); actions.append(b);
        }
        card.append(button, actions); list.append(card);
      }
    }
    for (const button of root.querySelectorAll('[data-tab]')) button.addEventListener('click', () => switchTab(button.dataset.tab));
    q('#mapEmpty').addEventListener('click', () => switchTab('create'));
    q('#mapSettings').addEventListener('click', () => {
      const open = q('.map-advanced').hidden; q('.map-advanced').hidden = !open; q('#mapSettings').setAttribute('aria-expanded', String(open));
    });
    q('#mapDifficulty').addEventListener('input', () => {
      const d = M.defaults(Number(q('#mapDifficulty').value));
      for (const [key] of ranges) q('#map-' + key).value = d[key];
      stale();
    });
    for (const input of root.querySelectorAll('#mapDifficulty, .map-advanced input, .map-advanced select')) {
      if (input.id !== 'mapDifficulty') input.addEventListener('input', stale);
      input.addEventListener('change', generate);
    }
    for (const input of root.querySelectorAll('#mapTitle, .medal-fields input')) input.addEventListener('input', () => setStatus(''));
    q('#generateMap').addEventListener('click', generate);
    q('#cancelMap').addEventListener('click', () => controller?.abort());
    q('#cancelImport').addEventListener('click', () => controller?.abort());
    q('#playMap').addEventListener('click', () => { const def = edited(); if (def) play(def); });
    q('#saveMap').addEventListener('click', () => {
      const def = edited(); if (!def) return;
      try { const result = library.save(def); draft = result.def; setStatus(result.persisted ? 'saved' : 'unsaved'); renderLibrary(); }
      catch { setStatus('unsaved'); }
    });
    q('#exportMap').addEventListener('click', () => { const def = edited(); if (def) download(def); });
    q('#undoMap').addEventListener('click', () => {
      if (!removed) return;
      try { const result = library.save(removed); setLibrary(result.persisted ? 'saved' : 'unsaved'); removed = null; q('#undoMap').hidden = true; renderLibrary(); }
      catch { setLibrary('unsaved'); }
    });
    q('#importMap').addEventListener('change', async event => {
      const file = event.target.files[0]; event.target.value = '';
      if (!file || controller) return;
      const task = new AbortController(); controller = task; busy(true); setLibrary('importing');
      try {
        if (file.size > 128000) throw new Error('invalid-map');
        const def = M.decode(await file.text());
        await M.evaluate(def, { signal: task.signal });
        const result = library.save(def); setLibrary(result.persisted ? 'saved' : 'unsaved'); renderLibrary();
      } catch (error) { setLibrary(error.name === 'AbortError' ? '' : 'invalid'); }
      finally { controller = null; busy(false); ready(Boolean(draft)); }
    });
    // A tab-local draft survives refresh without adding it to the saved map library.
    function snapshot() {
      const fields = {};
      for (const input of root.querySelectorAll('input:not([type="file"]), select')) fields[input.id] = input.value;
      return { tab, draft: draft ? M.documentFor(draft) : null, fields, advanced: !q('.map-advanced').hidden };
    }
    function restore(state) {
      if (!state || typeof state !== 'object') return;
      if (state.draft) {
        try { display(M.decode(JSON.stringify(state.draft))); } catch { /* damaged draft: keep the editor usable */ }
      }
      for (const input of root.querySelectorAll('input:not([type="file"]), select')) {
        const value = state.fields?.[input.id];
        if (typeof value === 'string' && value.length <= 100) input.value = value;
      }
      q('.map-advanced').hidden = !state.advanced;
      q('#mapSettings').setAttribute('aria-expanded', String(Boolean(state.advanced)));
      outputs();
      switchTab(['stages', 'create', 'mine'].includes(state.tab) ? state.tab : 'stages');
    }
    updateText(); ready(false); switchTab('stages');
    return { refresh: updateText, snapshot, restore };
  }
  CF.workshop = { create };
})(globalThis.Chartflip = globalThis.Chartflip || {});
