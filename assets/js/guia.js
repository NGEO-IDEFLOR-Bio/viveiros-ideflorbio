/* Guia dos Viveiros do PROSAF
 * Aplicação estática com Leaflet e dados normalizados pelo pipeline.
 */
const DATA_URL = 'assets/data/viveiros.json';
const BOUNDARY_URLS = {
  municipios: 'assets/data/municipios.geojson',
  ucs: 'assets/data/ucs_estaduais.geojson',
  regioes: 'assets/data/regioes_integracao.geojson',
  estado: 'assets/data/estado.geojson',
};
const MAPLIBRE = {
  css: 'assets/vendor/maplibre/maplibre-gl.css',
  js: 'assets/vendor/maplibre/maplibre-gl.js',
  leaflet: 'assets/vendor/maplibre-gl-leaflet/leaflet-maplibre-gl.js',
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const THEME_KEY = 'viveiros-theme';

const state = {
  data: null,
  byId: new Map(),
  boundaries: null,
  estadoBounds: null,
  map: null,
  mapToken: 0,
  pointLayer: null,
  highlightRing: null,
  highlightLayers: [],
  markers: new Map(),
  neutralLayer: null,
  neutralIsVector: false,
  overlays: null,
  theme: 'light',
  filters: {},
  selectedId: null,
  mapOptions: {},
  page: 1,
  pageSize: 40,
  drawerFrom: '#/',
  toastTimer: null,
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const norm = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();
const slugify = (value) => norm(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isMobile = () => window.matchMedia('(max-width: 920px)').matches;
const fmt = (value) => (value === null || value === undefined || value === '')
  ? 'não informado'
  : Number(value).toLocaleString('pt-BR');
const fmtCap = (value) => (value === null || value === undefined)
  ? 'sem informação'
  : `${fmt(value)} mudas`;
const dimensions = (v) => (v.largura_m && v.comprimento_m)
  ? `${fmt(v.largura_m)} × ${fmt(v.comprimento_m)} m`
  : (v.dimensoes_raw || 'não informado');
const area = (v) => (v.area_m2 ? `${fmt(v.area_m2)} m²` : 'não informado');
const dateBR = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
};

function debounce(fn, wait = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function toast(message, type = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show${type ? ` ${type}` : ''}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem(THEME_KEY, state.theme);
  const btn = $('#theme-toggle');
  if (btn) {
    btn.textContent = state.theme === 'dark' ? 'Claro' : 'Escuro';
    btn.setAttribute('aria-label', state.theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro');
  }
  if (state.neutralLayer) {
    if (state.neutralIsVector && state.neutralLayer.getMaplibreMap) {
      state.neutralLayer.getMaplibreMap()?.setStyle(basemapStyle());
    } else {
      state.neutralLayer.setUrl(neutralUrl());
    }
  }
}
function neutralUrl() {
  return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
}

function basemapStyle() {
  return state.theme === 'dark' ? MAPLIBRE.dark : MAPLIBRE.light;
}

let maplibrePromise = null;

function loadStylesheetOnce(href) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) {
      resolve();
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Falha ao carregar ${href}.`));
    document.head.appendChild(link);
  });
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Falha ao carregar ${src}.`));
    document.body.appendChild(script);
  });
}

async function loadMaplibre() {
  if (window.L?.maplibreGL) return true;
  if (!maplibrePromise) {
    maplibrePromise = (async () => {
      await loadStylesheetOnce(MAPLIBRE.css);
      await loadScriptOnce(MAPLIBRE.js);
      await loadScriptOnce(MAPLIBRE.leaflet);
      return !!window.L?.maplibreGL;
    })().catch((error) => {
      console.warn('[viveiros] mapa vetorial:', error);
      return false;
    });
  }
  return maplibrePromise;
}

/* ------------------------------------------------------------------ */
/* Carregamento                                                        */
/* ------------------------------------------------------------------ */
async function loadData() {
  const response = await fetch(DATA_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Falha ao carregar os dados (${response.status}).`);
  state.data = await response.json();
  state.byId = new Map(state.data.viveiros.map((v) => [v.id, v]));
}

async function loadBoundaries() {
  if (state.boundaries) return state.boundaries;
  const entries = await Promise.all(Object.entries(BOUNDARY_URLS).map(async ([key, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Falha ao carregar ${url}.`);
    return [key, await response.json()];
  }));
  state.boundaries = Object.fromEntries(entries);
  return state.boundaries;
}

/* ------------------------------------------------------------------ */
/* Filtros                                                             */
/* ------------------------------------------------------------------ */
function filtersFromParams(params) {
  return {
    q: params.get('q') || '',
    regiao: params.get('regiao') || '',
    municipio: params.get('municipio') || '',
    categoria: params.get('categoria') || '',
    unidade: params.get('unidade') || '',
    uc: params.get('uc') || '',
    faixa: params.get('faixa') || '',
    ordem: params.get('ordem') || 'capacidade-desc',
    viveiro: params.get('viveiro') || '',
  };
}

function filterViveiros(filters) {
  let list = state.data.viveiros;
  const q = norm(filters.q);
  if (q) {
    list = list.filter((v) => norm([
      v.nome, v.beneficiario, v.municipio, v.regiao, v.uc_nome, v.unidade,
    ].join(' ')).includes(q));
  }
  if (filters.regiao) list = list.filter((v) => v.regiao_slug === filters.regiao);
  if (filters.municipio) list = list.filter((v) => v.municipio_slug === filters.municipio);
  if (filters.categoria) list = list.filter((v) => v.categoria === filters.categoria);
  if (filters.unidade) list = list.filter((v) => v.unidade === filters.unidade);
  if (filters.uc) list = list.filter((v) => v.uc_nome && slugify(v.uc_nome) === filters.uc);
  if (filters.faixa) list = list.filter((v) => v.capacidade_faixa === filters.faixa);

  const sorters = {
    'capacidade-desc': (a, b) => (b.capacidade || 0) - (a.capacidade || 0),
    'capacidade-asc': (a, b) => (a.capacidade || 0) - (b.capacidade || 0),
    'nome': (a, b) => a.nome.localeCompare(b.nome, 'pt-BR'),
    'municipio': (a, b) => a.municipio.localeCompare(b.municipio, 'pt-BR') || a.nome.localeCompare(b.nome, 'pt-BR'),
  };
  return [...list].sort(sorters[filters.ordem] || sorters['capacidade-desc']);
}

function filtersToHash(filters, path = '#/viveiros') {
  const params = new URLSearchParams();
  for (const key of ['q', 'regiao', 'municipio', 'categoria', 'unidade', 'uc', 'faixa']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (filters.ordem && filters.ordem !== 'capacidade-desc') params.set('ordem', filters.ordem);
  return params.toString() ? `${path}?${params}` : path;
}

function hasActiveFilters(filters) {
  return ['q', 'regiao', 'municipio', 'categoria', 'unidade', 'uc', 'faixa'].some((key) => filters[key]);
}

function activeChips(filters) {
  const chips = [];
  const add = (key, label) => chips.push(`<span class="chip on">${esc(label)} <button type="button" data-clear="${key}" aria-label="Remover filtro ${esc(label)}">×</button></span>`);
  if (filters.q) add('q', `Busca: ${filters.q}`);
  if (filters.regiao) {
    const item = state.data.agregados.por_regiao.find((r) => r.slug === filters.regiao);
    if (item) add('regiao', item.nome);
  }
  if (filters.municipio) {
    const item = state.data.agregados.por_municipio.find((m) => m.slug === filters.municipio);
    if (item) add('municipio', item.nome);
  }
  if (filters.categoria) add('categoria', filters.categoria);
  if (filters.unidade) add('unidade', filters.unidade);
  if (filters.uc) {
    const item = state.data.agregados.por_uc.find((u) => u.slug === filters.uc);
    if (item) add('uc', item.nome_curto || item.nome);
  }
  if (filters.faixa) add('faixa', `Capacidade: ${filters.faixa}`);
  return chips.join('');
}

/* ------------------------------------------------------------------ */
/* Componentes de lista                                                */
/* ------------------------------------------------------------------ */
function resultRows(list, selectedId = '') {
  if (!list.length) {
    return `<div class="empty">Nenhum viveiro encontrado. Ajuste os filtros ou <button type="button" class="btn ghost small" data-clear-all>limpe a busca</button>.</div>`;
  }
  return list.map((v) => `
    <a class="result-row${v.id === selectedId ? ' sel' : ''}" href="#/viveiro/${v.id}" data-id="${v.id}">
      <span class="dot ${v.categoria === 'Comunitário' ? 'com' : 'ins'}" aria-hidden="true"></span>
      <span class="result-main">
        <strong>${esc(v.nome)}</strong>
        <small>${esc(v.municipio)} · ${esc(v.unidade)} · ${esc(dimensions(v))}${v.uc_nome_curto ? ` · ${esc(v.uc_nome_curto)}` : ''}</small>
      </span>
      <span class="cap">${fmt(v.capacidade)}<span>mudas</span></span>
    </a>
  `).join('');
}

function featuredViveiros(limit = 8) {
  const byMunicipio = new Set();
  const out = [];
  const sorted = [...state.data.viveiros].sort((a, b) => (b.capacidade || 0) - (a.capacidade || 0));
  for (const v of sorted) {
    if (byMunicipio.has(v.municipio)) continue;
    byMunicipio.add(v.municipio);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Mapa                                                                */
/* ------------------------------------------------------------------ */
function pointRadius(capacity) {
  return Math.max(4, Math.min(8.5, 3.5 + Math.sqrt(capacity || 0) / 95));
}

function pointColor(v) {
  return v.categoria === 'Comunitário' ? '#b45309' : '#15803d';
}

function addBaseLayers(map, useMaplibre) {
  let neutral;
  if (useMaplibre && L.maplibreGL) {
    neutral = L.maplibreGL({
      style: basemapStyle(),
      attribution: '&copy; OpenStreetMap contributors &copy; OpenMapTiles &copy; OpenFreeMap',
    }).addTo(map);
    state.neutralIsVector = true;
  } else {
    neutral = L.tileLayer(neutralUrl(), {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    state.neutralIsVector = false;
  }
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Esri, Maxar, Earthstar Geographics',
  });
  state.neutralLayer = neutral;
  state.baseLayers = { 'Mapa': neutral, 'Satélite': satellite };
  return { neutral, satellite };
}

function addBoundaries(map, boundaries) {
  const stateLayer = L.geoJSON(boundaries.estado, {
    style: { color: '#68757a', weight: 2, fill: false, opacity: 0.9 },
    interactive: false,
  }).addTo(map);
  state.estadoBounds = stateLayer.getBounds();

  const municipios = L.geoJSON(boundaries.municipios, {
    style: { color: '#b9b4a9', weight: 0.9, fill: false, opacity: 0.75 },
    onEachFeature: (feature, layer) => {
      const name = feature.properties?.NM_MUN;
      if (name) layer.bindTooltip(esc(name), { sticky: true, direction: 'top', opacity: 0.95 });
    },
  }).addTo(map);

  const ucs = L.geoJSON(boundaries.ucs, {
    style: { color: '#b45309', weight: 1.2, fillColor: '#b45309', fillOpacity: 0.1, opacity: 0.8 },
    onEachFeature: (feature, layer) => {
      const name = feature.properties?.NOME_;
      if (name) layer.bindTooltip(esc(name), { sticky: true, direction: 'top', opacity: 0.95 });
    },
  }).addTo(map);

  const regioes = L.geoJSON(boundaries.regioes, {
    style: { color: '#1351b4', weight: 1, dashArray: '4 4', fill: false, opacity: 0.55 },
    interactive: false,
  });

  state.overlays = { 'Municípios': municipios, 'UCs estaduais': ucs, 'Regionais': regioes };
  L.control.layers(state.baseLayers, state.overlays, { position: 'topright', collapsed: true }).addTo(map);
}

function clearHighlights() {
  if (!state.map) {
    state.highlightLayers = [];
    return;
  }
  for (const layer of state.highlightLayers) {
    try {
      state.map.removeLayer(layer);
    } catch (error) {
      // A camada pode já ter sido removida.
    }
  }
  state.highlightLayers = [];
}

function addHighlight(boundaries, options = {}) {
  if (!state.map || !boundaries) return;
  if (options.highlightMunicipio) {
    const target = boundaries.municipios.features.find((f) => norm(f.properties?.NM_MUN) === norm(options.highlightMunicipio));
    if (target) {
      const layer = L.geoJSON(target, {
        style: { color: '#15803d', weight: 2.5, fillColor: '#15803d', fillOpacity: 0.08 },
        interactive: false,
      }).addTo(state.map);
      state.highlightLayers.push(layer);
    }
  }
  if (options.highlightRegiao) {
    const target = boundaries.regioes.features.find((f) => norm(f.properties?.['Região de Integração']).includes(norm(options.highlightRegiao)));
    if (target) {
      const layer = L.geoJSON(target, {
        style: { color: '#1351b4', weight: 2, dashArray: '6 4', fillColor: '#1351b4', fillOpacity: 0.04 },
        interactive: false,
      }).addTo(state.map);
      state.highlightLayers.push(layer);
    }
  }
}

function addPoints(map, points, selectedId = '') {
  if (state.pointLayer) {
    map.removeLayer(state.pointLayer);
    state.pointLayer = null;
  }
  if (state.highlightRing) {
    map.removeLayer(state.highlightRing);
    state.highlightRing = null;
  }
  state.markers = new Map();
  const layer = L.layerGroup().addTo(map);
  for (const v of points) {
    const marker = L.circleMarker([v.lat, v.lon], {
      radius: pointRadius(v.capacidade),
      color: '#ffffff',
      weight: 1,
      fillColor: pointColor(v),
      fillOpacity: 0.92,
    });
    marker.bindTooltip(
      `<strong>${esc(v.nome)}</strong><br>${esc(v.municipio)} · ${fmtCap(v.capacidade)}`,
      { direction: 'top', opacity: 0.98, className: 'viveiro-tooltip' },
    );
    marker.on('click', () => openDrawer(v.id, { push: true }));
    marker.addTo(layer);
    state.markers.set(v.id, marker);
  }
  state.pointLayer = layer;

  if (selectedId) {
    const selected = state.byId.get(selectedId);
    if (selected) {
      state.highlightRing = L.circleMarker([selected.lat, selected.lon], {
        radius: 13,
        color: '#1351b4',
        weight: 2,
        fill: false,
      }).addTo(map);
      map.setView([selected.lat, selected.lon], Math.max(map.getZoom(), 9));
    }
  }
}

function fitToPoints(map, points) {
  if (points.length) {
    const bounds = L.latLngBounds(points.map((v) => [v.lat, v.lon]));
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.08), { maxZoom: points.length === 1 ? 12 : 8, animate: false });
      return;
    }
  }
  if (state.estadoBounds?.isValid()) {
    map.fitBounds(state.estadoBounds, { animate: false });
  }
}

function detachMap() {
  const mapEl = document.getElementById('map-persistent');
  const holder = document.getElementById('map-holder');
  if (mapEl && holder && mapEl.parentElement !== holder) holder.appendChild(mapEl);
}

function mountMap(slotId, options = {}) {
  const slot = document.getElementById(slotId);
  const mapEl = document.getElementById('map-persistent');
  if (!slot || !mapEl) return;
  slot.appendChild(mapEl);
  mapEl.hidden = false;
  state.mapOptions = options;
  if (!state.map) {
    initMap('map-persistent', options);
  } else {
    updateMap(options);
    const loading = slot.querySelector('.map-loading');
    if (loading) loading.remove();
    const map = state.map;
    setTimeout(() => {
      if (state.map === map) map.invalidateSize();
    }, 40);
  }
}

function updateMap(options = {}) {
  if (!state.map) return;
  state.mapOptions = options;
  clearHighlights();
  if (state.boundaries) addHighlight(state.boundaries, options);
  addPoints(state.map, options.points || [], options.selectedId || '');
  fitToPoints(state.map, options.points || []);
  if (options.selectedId) {
    const selected = state.byId.get(options.selectedId);
    if (selected) state.map.setView([selected.lat, selected.lon], Math.max(state.map.getZoom(), 9));
  }
}

async function initMap(containerId, options = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (state.map) {
    updateMap(options);
    return;
  }
  state.mapOptions = options;
  const token = state.mapToken;
  const map = L.map(el, {
    zoomControl: true,
    scrollWheelZoom: false,
    minZoom: 4,
    maxZoom: 14,
    preferCanvas: true,
  });
  state.map = map;
  const slot = el.parentElement;
  const loading = slot?.querySelector('.map-loading') || null;
  const [useMaplibre, boundaries] = await Promise.all([
    loadMaplibre(),
    loadBoundaries().catch((error) => {
      console.warn('[viveiros] camadas de contexto:', error);
      return null;
    }),
  ]);
  if (token !== state.mapToken) return;
  addBaseLayers(map, useMaplibre);
  const latest = state.mapOptions;

  if (boundaries) {
    addBoundaries(map, boundaries);
    clearHighlights();
    addHighlight(boundaries, latest);
  } else if (loading) {
    loading.textContent = 'Não foi possível carregar as camadas de contexto.';
  }

  if (token !== state.mapToken) return;
  addPoints(map, latest.points || [], latest.selectedId || '');
  fitToPoints(map, latest.points || []);
  if (latest.selectedId) {
    const selected = state.byId.get(latest.selectedId);
    if (selected) map.setView([selected.lat, selected.lon], Math.max(map.getZoom(), 9));
  }
  if (loading) loading.remove();
  const currentLoading = map.getContainer().parentElement?.querySelector('.map-loading');
  if (currentLoading) currentLoading.remove();
  setTimeout(() => {
    if (token === state.mapToken && state.map === map) map.invalidateSize();
  }, 40);
  return map;
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  return {
    parts: pathPart.split('/').filter(Boolean),
    params: new URLSearchParams(queryPart || ''),
  };
}

function route() {
  if (!state.data) return;
  const { parts, params } = parseHash();
  const path = parts[0] || 'home';
  detachMap();
  closeDrawer(false);

  if (path === 'viveiros') {
    renderCatalog(params);
  } else if (path === 'viveiro') {
    const id = parts[1] || params.get('viveiro');
    state.drawerFrom = '#/viveiros';
    renderCatalog(new URLSearchParams({ viveiro: id || '' }));
    if (id) openDrawer(id, { push: false });
  } else if (path === 'municipio') {
    renderProfile('municipio', parts[1]);
  } else if (path === 'regiao') {
    renderProfile('regiao', parts[1]);
  } else if (path === 'entenda') {
    renderEntenda();
  } else if (path === 'montagem') {
    renderMontagem();
  } else if (path === 'fontes') {
    renderFontes();
  } else {
    renderHome();
  }

  updateNav(path);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function updateNav(path) {
  const active = path === 'viveiro' || path === 'municipio' || path === 'regiao' ? 'viveiros' : path;
  $$('[data-nav]').forEach((link) => {
    link.classList.toggle('on', link.dataset.nav === active);
    if (link.dataset.nav === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */
function renderHome() {
  const d = state.data;
  const featured = featuredViveiros(8);
  const topRegioes = [...d.agregados.por_regiao].slice(0, 2);
  const notaMapa = topRegioes.length === 2
    ? `${topRegioes[0].nome} e ${topRegioes[1].nome} concentram ${fmt(topRegioes[0].viveiros + topRegioes[1].viveiros)} dos ${fmt(d.totals.viveiros)} viveiros da base.`
    : '';
  const app = $('#app');
  app.innerHTML = `
    <section class="hero">
      <div class="wrap hero-grid">
        <div>
          <p class="eyebrow">Projeto PROSAF · Produção de mudas</p>
          <h1>Guia dos Viveiros do PROSAF</h1>
          <p>Consulta do sistema de viveiros do Pará: o que é um viveiro, como é a montagem do modelo do IDEFLOR-Bio e onde estão as unidades instaladas. O conteúdo usa a base de dados atual, o manual de 2020 e os mapas oficiais.</p>
          <div class="hero-actions">
            <a class="btn primary" href="#/viveiros">Consultar os viveiros</a>
            <a class="btn" href="#/entenda">Entender o sistema</a>
            <a class="btn ghost" href="https://ideflorbio.pa.gov.br/wp-content/uploads/2023/11/Manual-de-Viveiro-de-Mudas-Ideflor-bio-2020-1.pdf" target="_blank" rel="noopener">Abrir o manual oficial</a>
          </div>
        </div>
        <div class="hero-stats" aria-label="Números da base">
          <div class="hero-stat"><b>${fmt(d.totals.viveiros)}</b><span>viveiros na base atual</span></div>
          <div class="hero-stat"><b>${fmt(d.totals.capacidade)}</b><span>mudas de capacidade declarada</span></div>
          <div class="hero-stat"><b>${fmt(d.totals.municipios)}</b><span>municípios com viveiros</span></div>
          <div class="hero-stat"><b>${fmt(d.totals.em_uc)}</b><span>em UCs estaduais</span></div>
        </div>
      </div>
    </section>

    <section class="home-layout">
      <div class="home-list">
        <div class="panel-head"><h2>Onde estão</h2><span>${fmt(d.totals.viveiros)} resultados</span></div>
        <form class="search-form" id="home-search">
          <label class="sr-only" for="home-search-input">Buscar viveiro, município ou beneficiário</label>
          <input id="home-search-input" type="search" placeholder="Buscar município, beneficiário ou região" autocomplete="off" />
          <button class="btn small" type="submit">Buscar</button>
        </form>
        <div class="list">
          ${featured.map((v) => `
            <a class="list-item" href="#/viveiro/${v.id}">
              <span class="dot ${v.categoria === 'Comunitário' ? 'com' : 'ins'}" aria-hidden="true"></span>
              <span>
                <strong>${esc(v.nome)}</strong>
                <small>${esc(v.municipio)} · ${esc(v.regiao)}${v.uc_nome_curto ? ` · ${esc(v.uc_nome_curto)}` : ''}</small>
              </span>
              <span class="cap">${fmt(v.capacidade)}<span>mudas</span></span>
            </a>
          `).join('')}
        </div>
      </div>
      <div class="home-map">
        <div class="map-card">
          <div class="map-head"><h2>Mapa de apoio</h2><span>${fmt(d.totals.viveiros)} pontos · ${fmt(d.totals.em_uc)} em UCs estaduais</span></div>
          <div class="map-slot" id="home-map-slot" ${isMobile() ? 'hidden' : ''}>
            <div class="map-loading">Carregando mapa...</div>
          </div>
          <button class="btn mobile-map-btn" type="button" data-map-toggle="home-map-slot">Ver mapa</button>
          <div class="map-legend">
            <span><i style="background:#b45309"></i>Viveiro comunitário</span>
            <span><i style="background:#15803d"></i>Viveiro institucional</span>
            <span><i style="background:#b45309;opacity:.25;border:1px solid #b45309"></i>UC estadual</span>
          </div>
          <p class="map-note">${esc(notaMapa)}</p>
        </div>
      </div>
    </section>

    <section class="themes" aria-label="Temas do guia">
      <a class="theme" href="#/entenda">
        <div class="k">Entenda</div>
        <h3>O que é um viveiro</h3>
        <p>O papel do viveiro no PROSAF e na produção de mudas para a recomposição florestal.</p>
      </a>
      <a class="theme" href="#/montagem">
        <div class="k">Monte</div>
        <h3>Etapas de montagem</h3>
        <p>O manual de 2020 organizado em um passo a passo com materiais, ferramentas e checklist.</p>
      </a>
      <a class="theme" href="#/viveiros">
        <div class="k">Explore</div>
        <h3>Catálogo de viveiros</h3>
        <p>${fmt(d.totals.viveiros)} viveiros em ${fmt(d.totals.regioes)} regionais. Filtre por município, categoria, unidade responsável e UC.</p>
      </a>
    </section>
  `;

  const search = $('#home-search');
  search?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#home-search-input').value.trim();
    location.hash = value ? `#/viveiros?q=${encodeURIComponent(value)}` : '#/viveiros';
  });

  bindMapToggles({ 'home-map-slot': () => ({ points: d.viveiros, selectedId: state.selectedId }) });
  if (!isMobile()) {
    mountMap('home-map-slot', { points: d.viveiros, selectedId: '' });
  }
}

/* ------------------------------------------------------------------ */
/* Catálogo                                                            */
/* ------------------------------------------------------------------ */
function selectOptions(items, selected, valueKey = 'slug', labelKey = 'nome', allLabel = 'Todos') {
  return [`<option value="">${esc(allLabel)}</option>`]
    .concat(items.map((item) => {
      const value = valueKey === 'nome' ? item.nome : item[valueKey];
      const label = labelKey === 'nome' ? item.nome : item[labelKey];
      return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
    }))
    .join('');
}

function renderCatalog(params) {
  const d = state.data;
  const filters = filtersFromParams(params);
  state.filters = filters;
  state.selectedId = filters.viveiro || '';
  state.page = 1;
  const list = filterViveiros(filters);
  const visible = list.slice(0, state.page * state.pageSize);
  const regions = [...d.agregados.por_regiao].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const municipios = [...d.agregados.por_municipio].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const unidades = [...d.agregados.por_unidade].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const ucs = [...d.agregados.por_uc].sort((a, b) => (a.nome_curto || a.nome).localeCompare(b.nome_curto || b.nome, 'pt-BR'));
  const faixas = d.agregados.faixas;
  const app = $('#app');

  app.innerHTML = `
    <section class="page-head">
      <div class="wrap">
        <p class="eyebrow">Consulta</p>
        <h1>Viveiros do PROSAF</h1>
        <p>${fmt(d.totals.viveiros)} viveiros em ${fmt(d.totals.municipios)} municípios e ${fmt(d.totals.regioes)} regionais. Filtre, consulte a ficha e baixe o recorte.</p>
      </div>
    </section>

    <div class="catalog-layout">
      <aside class="filters" id="catalog-filters" aria-label="Filtros">
        <h2>Filtros</h2>
        <p class="filter-count" id="filter-count">${fmt(list.length)} viveiros</p>
        <div class="filter-group">
          <label for="filter-regiao">Regional</label>
          <select id="filter-regiao" data-filter="regiao">${selectOptions(regions, filters.regiao, 'slug', 'nome', 'Todas as regionais')}</select>
        </div>
        <div class="filter-group">
          <label for="filter-municipio">Município</label>
          <select id="filter-municipio" data-filter="municipio">${selectOptions(municipios, filters.municipio, 'slug', 'nome', 'Todos os municípios')}</select>
        </div>
        <div class="filter-group">
          <label for="filter-categoria">Categoria</label>
          <select id="filter-categoria" data-filter="categoria">${selectOptions(d.agregados.por_categoria, filters.categoria, 'nome', 'nome', 'Todas as categorias')}</select>
        </div>
        <div class="filter-group">
          <label for="filter-unidade">Unidade responsável</label>
          <select id="filter-unidade" data-filter="unidade">${selectOptions(unidades, filters.unidade, 'nome', 'nome', 'Todas as unidades')}</select>
        </div>
        <div class="filter-group">
          <label for="filter-uc">Unidade de conservação</label>
          <select id="filter-uc" data-filter="uc">${selectOptions(ucs, filters.uc, 'slug', 'nome_curto', 'Todas as UCs')}</select>
        </div>
        <div class="filter-group">
          <label for="filter-faixa">Capacidade</label>
          <select id="filter-faixa" data-filter="faixa">${selectOptions(faixas, filters.faixa, 'nome', 'nome', 'Todas as faixas')}</select>
        </div>
        <div class="chips" id="active-chips">${activeChips(filters)}</div>
        <div class="filter-actions">
          <button class="btn small" type="button" id="clear-filters">Limpar filtros</button>
          <button class="btn small" type="button" id="download-filtered">Baixar recorte</button>
          <button class="btn small" type="button" id="share-filtered">Compartilhar recorte</button>
        </div>
      </aside>

      <section class="results" aria-label="Resultados">
        <div class="catalog-search">
          <label class="sr-only" for="catalog-search-input">Buscar viveiro, município ou beneficiário</label>
          <input id="catalog-search-input" type="search" placeholder="Buscar viveiro, município, beneficiário ou UC" value="${esc(filters.q)}" autocomplete="off" />
          <button class="btn small mobile-filter-btn" type="button" id="toggle-filters">Filtros</button>
        </div>
        <div class="results-head">
          <h2 id="results-count">${fmt(list.length)} viveiros</h2>
          <div class="results-actions">
            <button class="btn small mobile-map-btn" type="button" data-map-toggle="catalog-map-slot">Ver mapa</button>
            <div class="sort-row">
              <label for="sort-results">Ordenar</label>
              <select id="sort-results">
                <option value="capacidade-desc"${filters.ordem === 'capacidade-desc' ? ' selected' : ''}>Capacidade, maior primeiro</option>
                <option value="capacidade-asc"${filters.ordem === 'capacidade-asc' ? ' selected' : ''}>Capacidade, menor primeiro</option>
                <option value="nome"${filters.ordem === 'nome' ? ' selected' : ''}>Nome</option>
                <option value="municipio"${filters.ordem === 'municipio' ? ' selected' : ''}>Município</option>
              </select>
            </div>
          </div>
        </div>
        <div id="results-list">${resultRows(visible, state.selectedId)}${list.length > visible.length ? `<div class="load-more-wrap"><button class="btn small" type="button" id="load-more">Mostrar mais (${fmt(list.length - visible.length)} restantes)</button></div>` : ''}</div>
      </section>

      <aside class="catalog-map" aria-label="Mapa dos resultados">
        <div class="map-head"><h2>Mapa do recorte</h2><span id="map-count">${fmt(list.length)} pontos</span></div>
        <div class="map-slot" id="catalog-map-slot" ${isMobile() ? 'hidden' : ''}>
          <div class="map-loading">Carregando mapa...</div>
        </div>
        <button class="btn mobile-map-btn" type="button" data-map-toggle="catalog-map-slot">Ver mapa</button>
        <div class="map-legend">
          <span><i style="background:#b45309"></i>Comunitário</span>
          <span><i style="background:#15803d"></i>Institucional</span>
          <span><i style="background:#b45309;opacity:.25;border:1px solid #b45309"></i>UC estadual</span>
        </div>
        <p class="map-note">Clique em um ponto para abrir a ficha. Use o controle no canto do mapa para ligar ou desligar municípios, UCs e regionais.</p>
      </aside>
    </div>
  `;

  bindMapToggles({ 'catalog-map-slot': () => ({ points: filterViveiros(state.filters), selectedId: state.selectedId }) });
  bindCatalog(filters);

  if (isMobile()) {
    const filtersEl = $('#catalog-filters');
    if (filtersEl) filtersEl.hidden = true;
  } else {
    mountMap('catalog-map-slot', { points: list, selectedId: state.selectedId });
  }
}

function bindMapToggles(optionsById = {}) {
  $$('[data-map-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const slotId = button.dataset.mapToggle;
      const slot = document.getElementById(slotId);
      if (!slot) return;
      slot.hidden = false;
      button.hidden = true;
      $$(`[data-map-toggle="${slotId}"]`).forEach((other) => { other.hidden = true; });
      const source = optionsById[slotId];
      const options = typeof source === 'function' ? source() : (source || {});
      mountMap(slotId, options);
      setTimeout(() => slot.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    });
  });
}

function bindCatalog(filters) {
  const refresh = () => {
    const list = filterViveiros(state.filters);
    const visible = list.slice(0, state.page * state.pageSize);
    const results = $('#results-list');
    const count = $('#results-count');
    const filterCount = $('#filter-count');
    const mapCount = $('#map-count');
    if (results) {
      results.innerHTML = resultRows(visible, state.selectedId);
      if (list.length > visible.length) {
        results.insertAdjacentHTML('beforeend', `<div class="load-more-wrap"><button class="btn small" type="button" id="load-more">Mostrar mais (${fmt(list.length - visible.length)} restantes)</button></div>`);
      }
    }
    if (count) count.textContent = `${fmt(list.length)} viveiros`;
    if (filterCount) filterCount.textContent = `${fmt(list.length)} viveiros`;
    if (mapCount) mapCount.textContent = `${fmt(list.length)} pontos`;
    const chips = $('#active-chips');
    if (chips) chips.innerHTML = activeChips(state.filters);
    history.replaceState(null, '', filtersToHash(state.filters));
    if (state.map) updateMap({ points: list, selectedId: state.selectedId });
    else if (!isMobile()) mountMap('catalog-map-slot', { points: list, selectedId: state.selectedId });
  };

  $$('[data-filter]').forEach((select) => {
    select.addEventListener('change', () => {
      state.filters[select.dataset.filter] = select.value;
      state.filters.viveiro = '';
      state.selectedId = '';
      state.page = 1;
      refresh();
    });
  });

  const search = $('#catalog-search-input');
  if (search) {
    search.addEventListener('input', debounce(() => {
      state.filters.q = search.value.trim();
      state.filters.viveiro = '';
      state.selectedId = '';
      state.page = 1;
      refresh();
    }));
  }

  const sort = $('#sort-results');
  if (sort) {
    sort.addEventListener('change', () => {
      state.filters.ordem = sort.value;
      state.page = 1;
      refresh();
    });
  }

  const clear = $('#clear-filters');
  if (clear) {
    clear.addEventListener('click', () => {
      state.filters = { ordem: 'capacidade-desc' };
      state.selectedId = '';
      state.page = 1;
      $$('[data-filter]').forEach((select) => { select.value = ''; });
      if (search) search.value = '';
      if (sort) sort.value = 'capacidade-desc';
      refresh();
    });
  }

  const chips = $('#active-chips');
  if (chips) {
    chips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-clear]');
      if (!button) return;
      const key = button.dataset.clear;
      state.filters[key] = '';
      state.filters.viveiro = '';
      state.selectedId = '';
      state.page = 1;
      const select = $(`[data-filter="${key}"]`);
      if (select) select.value = '';
      if (key === 'q' && search) search.value = '';
      refresh();
    });
  }

  const download = $('#download-filtered');
  if (download) {
    download.addEventListener('click', () => {
      const list = filterViveiros(state.filters);
      downloadGeoJSON(list, 'viveiros-filtrados.geojson');
    });
  }

  const share = $('#share-filtered');
  if (share) {
    share.addEventListener('click', () => copyLink());
  }

  const toggle = $('#toggle-filters');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const panel = $('#catalog-filters');
      if (!panel) return;
      panel.hidden = !panel.hidden;
      toggle.textContent = panel.hidden ? 'Filtros' : 'Ocultar filtros';
    });
  }

  const resultsList = $('#results-list');
  if (resultsList) {
    resultsList.addEventListener('click', (event) => {
      if (event.target.closest('#load-more')) {
        state.page += 1;
        refresh();
        return;
      }
      if (event.target.closest('[data-clear-all]')) {
        event.preventDefault();
        state.filters = { ordem: 'capacidade-desc' };
        state.selectedId = '';
        state.page = 1;
        $$('[data-filter]').forEach((select) => { select.value = ''; });
        if (search) search.value = '';
        const sortSelect = $('#sort-results');
        if (sortSelect) sortSelect.value = 'capacidade-desc';
        refresh();
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Perfis                                                              */
/* ------------------------------------------------------------------ */
function renderProfile(kind, slug) {
  const d = state.data;
  const isMunicipio = kind === 'municipio';
  const source = isMunicipio ? d.agregados.por_municipio : d.agregados.por_regiao;
  const item = source.find((entry) => entry.slug === slug);
  if (!item) {
    $('#app').innerHTML = `<section class="page-head"><div class="wrap"><h1>Perfil não encontrado</h1><p><a href="#/viveiros">Voltar ao catálogo</a></p></div></section>`;
    return;
  }
  const list = d.viveiros.filter((v) => (isMunicipio ? v.municipio_slug === slug : v.regiao_slug === slug));
  const title = isMunicipio ? item.nome : item.nome;
  const subtitle = isMunicipio
    ? `${item.regiao} · ${fmt(item.viveiros)} viveiros`
    : `Regional PROSAF · ${fmt(item.viveiros)} viveiros em ${new Set(list.map((v) => v.municipio)).size} municípios`;
  const filterHash = isMunicipio
    ? filtersToHash({ municipio: item.slug, ordem: 'capacidade-desc' })
    : filtersToHash({ regiao: item.slug, ordem: 'capacidade-desc' });

  $('#app').innerHTML = `
    <section class="profile-head">
      <div class="wrap">
        <p class="eyebrow">${isMunicipio ? 'Município' : 'Regional PROSAF'}</p>
        <h1>${esc(title)}</h1>
        <p>${esc(subtitle)}</p>
      </div>
    </section>
    <div class="wrap">
      <div class="profile-stats">
        <div class="profile-stat"><b>${fmt(item.viveiros)}</b><span>viveiros</span></div>
        <div class="profile-stat"><b>${fmt(item.capacidade)}</b><span>mudas de capacidade declarada</span></div>
        <div class="profile-stat"><b>${fmt(item.comunitarios)}</b><span>comunitários</span></div>
        <div class="profile-stat"><b>${fmt(item.institucionais)}</b><span>institucionais</span></div>
      </div>
      <div class="profile-grid" style="padding-top:20px">
        <section>
          <div class="results-head">
            <h2>Viveiros</h2>
            <div class="results-actions">
              <button class="btn small mobile-map-btn" type="button" data-map-toggle="profile-map-slot">Ver mapa</button>
              <a class="btn small" href="${filterHash}">Abrir no catálogo</a>
            </div>
          </div>
          <div class="list">${resultRows(list)}</div>
        </section>
        <aside class="profile-map">
          <div class="map-head"><h2>Mapa</h2><span>${fmt(list.length)} pontos</span></div>
          <div class="map-slot" id="profile-map-slot" ${isMobile() ? 'hidden' : ''}>
            <div class="map-loading">Carregando mapa...</div>
          </div>
          <button class="btn mobile-map-btn" type="button" data-map-toggle="profile-map-slot">Ver mapa</button>
          <p class="map-note">${isMunicipio ? 'O contorno do município é destacado no mapa.' : 'A regional é destacada no mapa, quando disponível.'}</p>
        </aside>
      </div>
    </div>
  `;

  bindMapToggles({
    'profile-map-slot': () => ({
      points: list,
      highlightMunicipio: isMunicipio ? item.nome : '',
      highlightRegiao: isMunicipio ? '' : item.nome,
    }),
  });
  if (!isMobile()) {
    mountMap('profile-map-slot', {
      points: list,
      highlightMunicipio: isMunicipio ? item.nome : '',
      highlightRegiao: isMunicipio ? '' : item.nome,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Entenda                                                             */
/* ------------------------------------------------------------------ */
function planSvg() {
  // Estrutura 18 × 12 m: retângulo de 80,108 com largura 336 (18m) e altura 224 (12m).
  // Escala: 336 px / 18 m = 18.667 px/m; 224 px / 12 m = 18.667 px/m.
  // Vãos de 6 m:
  // Eixos X (longitudinal 18 m): 0 m (80), 6 m (192), 12 m (304), 18 m (416)
  // Eixos Y (transversal 12 m): 0 m (108), 6 m (220), 12 m (332)
  // Total de 12 colunas: 8 perimetrais + 4 no eixo central Y=220 (2 internas + 2 testeiras)
  const columns = [];
  for (const x of [80, 192, 304, 416]) {
    columns.push(`<circle class="column" cx="${x}" cy="108" r="4.2"/><circle class="column" cx="${x}" cy="332" r="4.2"/>`);
  }
  for (const x of [80, 192, 304, 416]) {
    columns.push(`<circle class="column" cx="${x}" cy="220" r="3.8"/>`);
  }

  // Irrigação: 6 linhas laterais e 24 microaspersores (4 por linha)
  // Laterais distribuídas uniformemente no vão de 12 m
  const laterals = [128, 164, 202, 238, 276, 312].map((y) => `<line class="irrigation" x1="88" y1="${y}" x2="408" y2="${y}"/>`).join('');
  const dots = [128, 164, 202, 238, 276, 312].flatMap((y) => [122, 192, 304, 374].map((x) => `<circle class="irrigation-dot" cx="${x}" cy="${y}" r="2.6"/>`)).join('');

  // 10 Mãos de força (estaiamento):
  // 4 nos cantos (2,85 m na diagonal) e 6 nas colunas intermediárias (2 m para fora)
  // Cantos: (80,108)->(56,84), (416,108)->(440,84), (80,332)->(56,356), (416,332)->(440,356)
  // Laterais comprimento (Y=108 e Y=332 em X=192 e X=304): para fora ~37px (2 m)
  // Laterais testeira (X=80 e X=416 em Y=220): para fora ~37px (2 m)
  const anchors = [
    // 4 cantos
    [80, 108, 56, 84], [416, 108, 440, 84], [80, 332, 56, 356], [416, 332, 440, 356],
    // 2 nas testeiras (colunas centrais de entrada/saída)
    [80, 220, 43, 220], [416, 220, 453, 220],
    // 4 nas laterais dos 18 m (colunas dos vãos de 6 m)
    [192, 108, 192, 71], [304, 108, 304, 71],
    [192, 332, 192, 369], [304, 332, 304, 369],
  ].map(([x1, y1, x2, y2]) => `<line class="anchor" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><circle class="anchor-dot" cx="${x2}" cy="${y2}" r="2.6"/>`).join('');

  return `
  <svg class="diagram-svg" viewBox="0 0 460 400" role="img" aria-labelledby="plan-title plan-desc">
    <title id="plan-title">Planta do viveiro de 12 por 18 metros</title>
    <desc id="plan-desc">Planta esquemática com a área livre de 16 por 22 metros, a estrutura de 18 por 12 metros, colunas em vãos de 6 metros, 10 mãos de força, linhas de irrigação e microaspersores.</desc>
    <rect x="34" y="38" width="412" height="334" fill="none" stroke="#b9b4a9" stroke-dasharray="4 4"/>
    <text class="label" x="38" y="28">área livre 16 × 22 m</text>
    <text class="label" x="24" y="220" transform="rotate(-90 24 220)" text-anchor="middle">12 m</text>
    <text class="label" x="248" y="392" text-anchor="middle">18 m</text>

    <rect class="structure" x="80" y="108" width="336" height="224"/>
    ${laterals}
    <line class="irrigation-main" x1="80" y1="312" x2="416" y2="312"/>
    ${dots}
    ${columns}
    ${anchors}

    <text class="label-strong" x="80" y="52">estrutura 18 × 12 m · 216 m²</text>
    <text class="label-strong" x="80" y="94">cobertura de sombrite 50%</text>
    <text class="label-strong" x="92" y="122">linhas laterais</text>
    <text class="label-water" x="92" y="324">linha principal</text>
    <text class="label-anchor" x="430" y="68" text-anchor="end">10 mãos de força</text>

    <circle class="number" cx="80" cy="108" r="9"/><text class="number-text" x="80" y="111" text-anchor="middle">1</text>
    <circle class="number" cx="440" cy="84" r="9"/><text class="number-text" x="440" y="87" text-anchor="middle">2</text>
    <circle class="number" cx="248" cy="148" r="9"/><text class="number-text" x="248" y="151" text-anchor="middle">3</text>
    <circle class="number" cx="374" cy="238" r="9"/><text class="number-text" x="374" y="241" text-anchor="middle">4</text>
  </svg>`;
}

function sectionSvg() {
  return `
  <svg class="diagram-svg" viewBox="0 0 560 440" role="img" aria-labelledby="section-title section-desc">
    <title id="section-title">Corte do viveiro</title>
    <desc id="section-desc">Corte esquemático com colunas, pé-direito de 2,4 metros, cobertura de sombrite, saia lateral, linha de microaspersão, caixa d'água, bomba e base de concreto.</desc>
    <line class="ground" x1="20" y1="360" x2="540" y2="360"/>
    <rect class="barracao" x="20" y="270" width="62" height="90"/>
    <line class="structure-line" x1="20" y1="270" x2="51" y2="248"/>
    <line class="structure-line" x1="51" y1="248" x2="82" y2="270"/>
    <text class="label" x="22" y="382">barracão</text>
    <text class="label" x="22" y="394">e sementeira</text>
    <circle class="number" cx="88" cy="300" r="9"/><text class="number-text" x="88" y="303" text-anchor="middle">5</text>

    <rect class="concrete" x="100" y="348" width="28" height="14"/>
    <rect class="concrete" x="266" y="348" width="28" height="14"/>
    <rect class="concrete" x="436" y="348" width="28" height="14"/>
    <line class="structure-line" x1="114" y1="360" x2="114" y2="120" stroke-width="5"/>
    <line class="structure-line" x1="280" y1="360" x2="280" y2="120" stroke-width="5"/>
    <line class="structure-line" x1="450" y1="360" x2="450" y2="120" stroke-width="5"/>
    <line class="anchor" x1="114" y1="120" x2="76" y2="232"/>
    <circle class="anchor-dot" cx="76" cy="232" r="2.6"/>

    <polygon class="roof" points="70,112 490,100 490,114 70,126"/>
    <line class="skirt" x1="70" y1="126" x2="70" y2="166"/>
    <line class="skirt" x1="490" y1="114" x2="490" y2="154"/>
    <text class="label-strong" x="300" y="92">sombrite 50%</text>
    <text class="label" x="500" y="142">saia 1,5 m</text>

    <circle class="number" cx="130" cy="150" r="9"/><text class="number-text" x="130" y="153" text-anchor="middle">1</text>
    <circle class="number" cx="62" cy="242" r="9"/><text class="number-text" x="62" y="245" text-anchor="middle">2</text>
    <circle class="number" cx="370" cy="88" r="9"/><text class="number-text" x="370" y="91" text-anchor="middle">3</text>
    <circle class="number" cx="325" cy="218" r="9"/><text class="number-text" x="325" y="221" text-anchor="middle">4</text>

    <line class="irrigation" x1="114" y1="176" x2="450" y2="176"/>
    ${[150, 230, 310, 390].map((x) => `
      <line class="irrigation" x1="${x}" y1="176" x2="${x}" y2="196" stroke-dasharray="2 4"/>
      <circle class="irrigation-dot" cx="${x}" cy="198" r="3"/>
      <line class="irrigation" x1="${x - 8}" y1="208" x2="${x}" y2="198" stroke-dasharray="2 4"/>
      <line class="irrigation" x1="${x + 8}" y1="208" x2="${x}" y2="198" stroke-dasharray="2 4"/>
    `).join('')}
    <text class="label-water" x="300" y="168">microaspersão</text>

    <text class="label" x="132" y="244" transform="rotate(-90 132 244)">pé-direito 2,4 m</text>
    <text class="label" x="108" y="386">concreto 3:2:1</text>

    <rect class="water" x="498" y="248" width="42" height="84"/>
    <text class="label-water" x="498" y="240">caixa d'água</text>
    <rect class="pump" x="470" y="304" width="24" height="22"/>
    <text class="label-anchor" x="456" y="340">bomba 2 CV</text>
    <line class="irrigation" x1="470" y1="315" x2="450" y2="315"/>
    <line class="irrigation" x1="450" y1="315" x2="450" y2="176"/>
    <text class="label" x="468" y="354">filtro 120 mesh</text>
  </svg>`;
}

function renderEntenda() {
  const d = state.data;
  const com = d.agregados.por_categoria.find((c) => c.nome === 'Comunitário') || { viveiros: 0, capacidade: 0 };
  const ins = d.agregados.por_categoria.find((c) => c.nome === 'Institucional') || { viveiros: 0, capacidade: 0 };
  $('#app').innerHTML = `
    <section class="editorial">
      <div class="wrap">
        <p class="eyebrow">Entenda o sistema</p>
        <h1>O que é um viveiro</h1>
        <p class="lead">O viveiro é a estrutura onde se produzem as mudas usadas na recomposição de áreas alteradas e nos Sistemas Agroflorestais. O modelo do IDEFLOR-Bio combina estrutura metálica, sombrite 50%, microaspersão e sementeira suspensa, com módulos de 36 m² a 1.152 m².</p>

        <div class="fact-grid">
          <div class="fact"><b>${fmt(d.totals.viveiros)}</b><span>viveiros na base atual</span></div>
          <div class="fact"><b>${fmt(com.viveiros)}</b><span>comunitários</span></div>
          <div class="fact"><b>${fmt(ins.viveiros)}</b><span>institucionais</span></div>
          <div class="fact"><b>${fmt(d.totals.capacidade)}</b><span>mudas de capacidade declarada</span></div>
        </div>

        <h2>Componentes do modelo 12 × 18 m</h2>
        <p>O módulo de referência do manual tem 216 m² e capacidade para 14 mil mudas. A planta mostra a estrutura, o estaiamento e a irrigação; o corte mostra o pé-direito, a cobertura, a saia lateral e a captação de água.</p>
        <div class="anatomy-grid">
          <figure>${planSvg()}<figcaption>Planta: estrutura, colunas, mãos de força e linhas de irrigação.</figcaption></figure>
          <figure>${sectionSvg()}<figcaption>Corte: pé-direito de 2,4 m, sombrite, microaspersão e caixa d'água.</figcaption></figure>
          <ul class="legend-list">
            <li><span class="n">1</span><div><b>Estrutura metálica</b> tubos galvanizados, colunas laterais e centrais, pé-direito de 2,4 m.</div></li>
            <li><span class="n">2</span><div><b>Estaiamento</b> 10 mãos de força com cabos de aço e esticadores; 2,85 m nos cantos.</div></li>
            <li><span class="n">3</span><div><b>Sombrite 50%</b> 105 m lineares para o módulo 12 × 18 m, com saia de 1,5 m nas laterais.</div></li>
            <li><span class="n">4</span><div><b>Microaspersão</b> linha principal de 50 mm, 6 linhas laterais e 24 microaspersores.</div></li>
            <li><span class="n">5</span><div><b>Estruturas anexas</b> barracão de 6 × 8 m e sementeira suspensa de 1 × 1 × 8 m.</div></li>
          </ul>
        </div>

        <h2>Tipos de viveiro</h2>
        <div class="type-grid">
          <div class="type com">
            <b>Comunitário</b>
            <span>${fmt(com.viveiros)} unidades · ${fmt(com.capacidade)} mudas</span>
            <p>Operado por comunidades, associações e parceiros locais.</p>
          </div>
          <div class="type">
            <b>Institucional</b>
            <span>${fmt(ins.viveiros)} unidades · ${fmt(ins.capacidade)} mudas</span>
            <p>Prefeituras, universidades, institutos e o próprio IDEFLOR-Bio.</p>
          </div>
        </div>

        <h2>A produção de mudas e os SAFs</h2>
        <p>A muda produzida no viveiro é usada na implantação de Sistemas Agroflorestais e na recuperação de áreas alteradas. O guia relaciona essa produção com os viveiros, os municípios e as UCs. Cada ficha apresenta os dados disponíveis na base.</p>
        <div class="callout">O manual de 2020 descreve o passo a passo de montagem, os materiais e as ferramentas. O guia organiza esse conteúdo na página <a href="#/montagem">Montagem</a>.</div>
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------------ */
/* Montagem                                                            */
/* ------------------------------------------------------------------ */
const STEPS = [
  {
    title: 'Demarcar e esquadrejar',
    text: 'Reserve a área livre de 16 × 22 m para o módulo 12 × 18 m, monte os travessões no chão para esquadrejar e marque os furos. O maior comprimento fica no sentido leste-oeste.',
    tag: 'Preparo · trena, cavadeira, corda',
  },
  {
    title: 'Erguer a estrutura metálica',
    text: 'Monte as laterais no chão, levante com equipe sincronizada, alinhe o prumo e fixe as colunas com barro e concreto 3:2:1.',
    tag: 'Estrutura · tubos galvanizados',
  },
  {
    title: 'Estaiar',
    text: 'Instale as 10 mãos de força a 2 m das colunas (2,85 m nos cantos), com cabos de aço e esticadores. O tensionamento final vem depois do aramado.',
    tag: 'Estrutura · cabos e esticadores',
  },
  {
    title: 'Montar o aramado superior',
    text: 'Fixe os arames 14 e 16 sobre as conexões, com o nó de colher. Para o módulo 12 × 18 m: 3 pernas de arame 14 e 10 de arame 16.',
    tag: 'Estrutura · arames 14 e 16',
  },
  {
    title: 'Instalar a irrigação',
    text: 'Linha principal de 50 mm, 6 linhas laterais de 16 mm, 24 microaspersores, filtro de disco 120 mesh, registro e ladrão.',
    tag: 'Irrigação · PVC e microaspersão',
  },
  {
    title: 'Cobrir com sombrite 50%',
    text: 'Corte, costure e instale a tela única com saia de 1,5 m nas quatro laterais. São 105 m lineares (315 m²) para o módulo 12 × 18 m.',
    tag: 'Cobertura · sombrite e cabo de aço',
  },
  {
    title: 'Finalizar anexos e testar',
    text: 'Barracão de 6 × 8 m, sementeira suspensa, limpeza das linhas e teste dos microaspersores, filtro e registro.',
    tag: 'Entrega · checklist final',
  },
];

const MATERIALS = [
  {
    title: 'Estrutura',
    items: [
      ['01', 'Tubo galvanizado com rosca 1.1/2" × 2,65 mm (colunas laterais e travessões)', 'vara', '15'],
      ['02', 'Tubo galvanizado 1/2" × 2,65 mm (coluna central)', 'vara', '2'],
      ['03', 'Tubo galvanizado 3/4" × 2,65 mm (mãos de força)', 'vara', '2'],
      ['04', 'Cotovelo galvanizado com saída lateral 1.1/2"', 'un.', '4'],
      ['05', 'Tê galvanizado 1.1/2"', 'un.', '6'],
      ['06', 'Esticador 5/16" gancho/olhal M8 galvanizado', 'un.', '10'],
      ['07', 'Arame galvanizado nº 12', 'kg', '2'],
      ['08', 'Arame galvanizado nº 14', 'kg', '4'],
      ['09', 'Arame galvanizado nº 16', 'kg', '4'],
      ['10', 'Arame galvanizado nº 20', 'kg', '1'],
      ['11', 'Tela de sombreamento 50% (rolo 3 × 50 m)', 'm', '105'],
      ['12', 'Fio sombrite', 'rolo', '3'],
      ['13', 'Cabo de aço plastificado 1,6 mm', 'm', '100'],
      ['14', 'Tela pinteiro 1,5 m (cercado)', 'm', '100'],
      ['15', 'Grampo para cerca', 'kg', '1'],
      ['16', 'Cimento, areia e seixo (traço 3:2:1)', 'conjunto', '1 sc + 0,5 m³ + 0,5 m³'],
    ],
  },
  {
    title: 'Irrigação',
    items: [
      ['01', 'Caixa d’água de 3.000 a 5.000 L, em fibra', 'un.', '1'],
      ['02', 'Bomba centrífuga de 2 CV', 'un.', '1'],
      ['03', 'Filtro de disco 1.1/2" com 120 mesh', 'un.', '1'],
      ['04', 'Tubo soldável 50 mm, 6 m', 'vara', '4'],
      ['05', 'Registro de esfera soldável 50 mm', 'un.', '2'],
      ['06', 'Registro combinado 16 mm com chula', 'un.', '7'],
      ['07', 'Chula 16 mm / anel de vedação bilabial', 'un.', '7'],
      ['08', 'Tubo de polietileno 16 mm PN 30', 'm', '100'],
      ['09', 'Microaspersor montado', 'un.', '24'],
      ['10', 'Fim de linha tipo oito 16 mm ou tampão', 'un.', '7'],
      ['11', 'Adesivo plástico para PVC, 75 g', 'un.', '1'],
      ['12', 'Fita veda rosca 18 mm × 25 m', 'un.', '2'],
      ['13', 'Lixa para cano P100', 'folha', '4'],
    ],
  },
  {
    title: 'Ferramentas',
    items: [
      ['01', 'Trena longa de 50 m', 'un.', '1'],
      ['02', 'Trena de bolso de 5 m', 'un.', '1'],
      ['03', 'Arco de serra fixo de 12" com cabo de metal', 'un.', '1'],
      ['04', 'Marreta oitavada de 5 kg com cabo de 90 cm', 'un.', '1'],
      ['05', 'Chave de corrente ou chave de grifo 24"', 'un.', '1'],
      ['06', 'Chave inglesa robusta', 'un.', '1'],
      ['07', 'Broca espiral 5/8" e 16 mm para PVC', 'un.', '1'],
      ['08', 'Broca 3 mm e 6 mm para tubo galvanizado', 'un.', '1'],
      ['09', 'Alicate universal de pressão 8"', 'un.', '1'],
      ['10', 'Alicate de corte diagonal 16 mm', 'un.', '1'],
      ['11', 'Tesoura profissional para tecido', 'un.', '1'],
      ['12', 'Escova manual de aço e lixa nº 100', 'un.', '1'],
      ['13', 'Lima chata 8" e lima triangular 4"', 'un.', '1'],
      ['14', 'Chaves de fenda, Phillips e canhão 7/8 mm', 'conjunto', '1'],
      ['15', 'Caixa de ferramenta sanfonada com 5 gavetas', 'un.', '1'],
      ['16', 'Escada de alumínio de 4 degraus', 'un.', '1'],
      ['17', 'Furadeira elétrica de impacto', 'un.', '1'],
    ],
  },
];

function renderMontagem() {
  $('#app').innerHTML = `
    <section class="editorial">
      <div class="wrap">
        <p class="eyebrow">Manual de montagem · módulo 12 × 18 m</p>
        <h1>Etapas de montagem do viveiro</h1>
        <p class="lead">O resumo abaixo segue o manual de 2020. Cada etapa pode abrir o detalhe técnico e as fotos no documento oficial. A lista de materiais e o kit de ferramentas ficam no fim da página.</p>

        <div class="montagem-layout">
          <div class="steps">
            ${STEPS.map((step, index) => `
              <div class="step">
                <div class="step-num">${index + 1}</div>
                <div>
                  <b>${esc(step.title)}</b>
                  <p>${esc(step.text)}</p>
                  <em>${esc(step.tag)}</em>
                </div>
              </div>
            `).join('')}
          </div>

          <aside class="ficha-box">
            <h2>Ficha da montagem</h2>
            <div class="big">12 × 18 m<span>216 m² · 14.000 mudas</span></div>
            <dl>
              <dt>Área livre</dt><dd>16 × 22 m</dd>
              <dt>Tempo</dt><dd>2 a 3 dias</dd>
              <dt>Equipe</dt><dd>8 a 10 pessoas</dd>
              <dt>Pé-direito</dt><dd>2,4 m</dd>
              <dt>Sombrite</dt><dd>105 m lineares</dd>
              <dt>Microaspersores</dt><dd>24</dd>
              <dt>Concreto</dt><dd>3 : 2 : 1</dd>
            </dl>
            <button class="btn primary" type="button" id="print-checklist">Imprimir checklist</button>
            <a class="btn" href="https://ideflorbio.pa.gov.br/wp-content/uploads/2023/11/Manual-de-Viveiro-de-Mudas-Ideflor-bio-2020-1.pdf" target="_blank" rel="noopener">Abrir o manual oficial</a>
          </aside>
        </div>

        <h2>Materiais e ferramentas</h2>
        <p>Lista de referência do Anexo 01 do manual para o módulo 12 × 18 m. Quantidades de outros tamanhos precisam de adaptação técnica.</p>
        ${MATERIALS.map((group, index) => `
          <details class="mat-group"${index === 0 ? ' open' : ''}>
            <summary>${esc(group.title)}</summary>
            <div class="table-wrap">
              <table class="mat-table">
                <thead><tr><th>Item</th><th>Especificação</th><th>Unid.</th><th>Qtd.</th></tr></thead>
                <tbody>
                  ${group.items.map(([item, spec, unit, qty]) => `
                    <tr><td>${esc(item)}</td><td>${esc(spec)}</td><td>${esc(unit)}</td><td>${esc(qty)}</td></tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </details>
        `).join('')}
        <p class="mat-note">O manual também descreve o barracão de 6 × 8 m e a sementeira suspensa de 1 × 1 × 8 m. Consulte o documento oficial para as quantidades e as especificações completas.</p>
        <div class="callout">O tempo de montagem de 2 a 3 dias considera uma equipe de 8 a 10 pessoas e condições locais favoráveis. O manual recomenda preparar os componentes menores antes da montagem e testar a irrigação no fim.</div>
      </div>
    </section>
  `;

  const print = $('#print-checklist');
  if (print) {
    print.addEventListener('click', () => {
      const groups = $$('.mat-group');
      const states = groups.map((group) => group.open);
      groups.forEach((group) => { group.open = true; });
      window.print();
      setTimeout(() => groups.forEach((group, index) => { group.open = states[index]; }), 600);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Fontes                                                              */
/* ------------------------------------------------------------------ */
function renderFontes() {
  const d = state.data;
  $('#app').innerHTML = `
    <section class="editorial">
      <div class="wrap">
        <p class="eyebrow">Fontes e metodologia</p>
        <h1>De onde vêm os dados</h1>
        <p class="lead">O guia usa a base de viveiros do PROSAF, o manual de montagem de 2020 e os mapas oficiais. Os arquivos originais continuam disponíveis para download.</p>

        <h2>Documentos oficiais</h2>
        <ul>
          <li><a href="https://ideflorbio.pa.gov.br/projeto-prosaf/" target="_blank" rel="noopener">Página do PROSAF</a>, com a narrativa do projeto, fotos e a lista de documentos.</li>
          <li><a href="https://ideflorbio.pa.gov.br/wp-content/uploads/2023/11/Manual-de-Viveiro-de-Mudas-Ideflor-bio-2020-1.pdf" target="_blank" rel="noopener">Manual de Viveiro de Mudas, IDEFLOR-Bio, 2020</a>.</li>
          <li><a href="https://ideflorbio.pa.gov.br/wp-content/uploads/2023/11/viveiros-2020-convertido.pdf" target="_blank" rel="noopener">Mapa dos viveiros, 2020</a>.</li>
          <li><a href="https://ideflorbio.pa.gov.br/wp-content/uploads/2023/11/Mapa-viveiros.pdf" target="_blank" rel="noopener">Mapa com a lista de localidades</a>.</li>
        </ul>

        <h2>Base de dados</h2>
        <p>A base atual tem ${fmt(d.totals.viveiros)} viveiros em ${fmt(d.totals.municipios)} municípios e ${fmt(d.totals.regioes)} regionais. A capacidade declarada soma ${fmt(d.totals.capacidade)} mudas. ${fmt(d.totals.em_uc)} viveiros estão em ${fmt(d.totals.ucs)} UCs estaduais.</p>
        <p>O pipeline lê os GeoJSON originais, normaliza capacidade, dimensões, municípios e beneficiários, faz o join espacial com municípios e UCs, calcula os agregados e gera os arquivos de consulta. As camadas de contexto são simplificadas com mapshaper para o mapa.</p>

        <h2>Limites e diferenças</h2>
        <ul>
          <li>O mapa de 2021 lista 199 localidades; a base atual tem 288 pontos; a página do PROSAF menciona 250 ou mais viveiros. Os números têm datas e recortes diferentes e não devem ser somados.</li>
          <li>A página do PROSAF informa cerca de 4.011.040 mudas; a soma da base atual é 4.484.185. O guia trata o valor como capacidade declarada, com a data da base.</li>
          <li>Dos 46 pontos de São Félix do Xingu, 7 caem fora do polígono municipal na base atual. A inconsistência está registrada nesta página e deve ser conferida na curadoria.</li>
          <li>Há uma coordenada duplicada na base.</li>
          <li>A regionalização usada na base do PROSAF é a mesma dos mapas de 2020 e pode diferir de outras regionalizações do estado.</li>
          <li>A base não traz nome próprio em todos os registros. O nome de exibição é reconstruído a partir da categoria, do beneficiário e do município.</li>
        </ul>

        <h2>Downloads</h2>
        <ul>
          <li><a href="data/viveiros.geojson" download>Viveiros, GeoJSON original</a>.</li>
          <li><a href="data/municipios.geojson" download>Municípios, GeoJSON original</a>.</li>
          <li><a href="data/ucs_estaduais.geojson" download>UCs estaduais, GeoJSON original</a>.</li>
          <li><a href="data/regioes_integracao.geojson" download>Regionais, GeoJSON original</a>.</li>
          <li><a href="assets/data/viveiros.json" download>Base normalizada, JSON</a>.</li>
        </ul>

        <p class="small muted">Base gerada em ${esc(dateBR(d.gerado_em))}. O guia não substitui os documentos oficiais.</p>
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------------ */
/* Ficha                                                               */
/* ------------------------------------------------------------------ */
function relatedViveiros(v) {
  const same = state.data.viveiros.filter((item) => item.id !== v.id && (
    (v.uc_nome && item.uc_nome === v.uc_nome) || item.municipio_slug === v.municipio_slug
  ));
  return same.slice(0, 3);
}

function openDrawer(id, options = {}) {
  const v = state.byId.get(id);
  if (!v) return;
  if (options.push && !location.hash.startsWith('#/viveiro/')) {
    state.drawerFrom = location.hash || '#/';
  }
  if (options.push) {
    history.pushState(null, '', `#/viveiro/${v.id}`);
  }
  state.selectedId = v.id;

  const ucContext = v.uc_nome
    ? `Este viveiro está na ${esc(v.uc_nome)} (${esc(v.uc_grupo || 'grupo não informado')}). A base registra ${fmt(state.data.agregados.por_uc.find((u) => u.nome === v.uc_nome)?.viveiros || 0)} viveiros nessa UC.`
    : 'A base não identifica este viveiro dentro de uma UC estadual.';

  const related = relatedViveiros(v);
  const content = $('#drawer-content');
  content.innerHTML = `
    <span class="tag ${v.categoria === 'Comunitário' ? 'com' : 'ins'} drawer-tag">${esc(v.categoria)}</span>
    <h2 class="drawer-title" id="drawer-title">${esc(v.nome)}</h2>
    <p class="drawer-sub">${esc(v.municipio)} · ${esc(v.regiao)} · ${esc(v.unidade)}</p>

    <div class="drawer-actions">
      <button class="btn primary small" type="button" data-map-viveiro="${esc(v.id)}">Ver no mapa</button>
      <button class="btn small" type="button" data-share>Compartilhar</button>
      <button class="btn small" type="button" data-download-viveiro="${esc(v.id)}">Baixar GeoJSON</button>
      <a class="btn small" href="https://ideflorbio.pa.gov.br/projeto-prosaf/" target="_blank" rel="noopener">Fonte oficial</a>
    </div>

    <div class="drawer-section">
      <h3>Ficha rápida</h3>
      <table class="fact-table">
        <tr><th>Categoria</th><td>${esc(v.categoria)}</td></tr>
        <tr><th>Beneficiário</th><td>${esc(v.beneficiario || 'não informado')}</td></tr>
        <tr><th>Capacidade</th><td>${esc(fmtCap(v.capacidade))}</td></tr>
        <tr><th>Dimensões</th><td>${esc(dimensions(v))}</td></tr>
        <tr><th>Área</th><td>${esc(area(v))}</td></tr>
        <tr><th>Unidade responsável</th><td>${esc(v.unidade)}</td></tr>
        <tr><th>Regional PROSAF</th><td>${esc(v.regiao)}</td></tr>
        <tr><th>Região oficial</th><td>${esc(v.regiao_oficial || 'não informada')}</td></tr>
        <tr><th>UC estadual</th><td>${esc(v.uc_nome || 'não identificada')}</td></tr>
        <tr><th>Coordenadas</th><td>${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}</td></tr>
      </table>
    </div>

    <div class="drawer-section">
      <h3>Contexto</h3>
      <p>${ucContext}</p>
      <p>${v.uc_nome ? `A UC é classificada como ${esc(v.uc_grupo || 'grupo não informado')}.` : 'O guia usa o join espacial da base para identificar a UC; a ausência de UC não confirma que o viveiro esteja fora de todas as áreas protegidas.'}</p>
    </div>

    <div class="drawer-section">
      <h3>Viveiros relacionados</h3>
      <div class="related">
        ${related.length ? related.map((item) => `
          <a href="#/viveiro/${item.id}">
            <span>${esc(item.nome)}</span>
            <span>${esc(item.municipio)} · ${fmt(item.capacidade)} mudas</span>
          </a>
        `).join('') : '<p>Nenhum viveiro relacionado na base.</p>'}
      </div>
    </div>

    <p class="source-note">O nome de exibição é reconstruído a partir da categoria, do beneficiário e do município. O documento oficial, as fotos e os contatos estão na página do PROSAF. Base gerada em ${esc(dateBR(state.data.gerado_em))}.</p>
  `;

  const drawer = $('#drawer');
  drawer.hidden = false;
  document.body.classList.add('drawer-open');
  $('.drawer-close')?.focus();

  content.querySelector('[data-share]')?.addEventListener('click', () => copyLink());
  content.querySelector('[data-download-viveiro]')?.addEventListener('click', () => downloadGeoJSON([v], `viveiro-${v.id}.geojson`));
  content.querySelector('[data-map-viveiro]')?.addEventListener('click', () => {
    const target = filtersToHash({ municipio: v.municipio_slug, ordem: 'capacidade-desc' });
    location.hash = `${target}&viveiro=${v.id}`;
    closeDrawer(false);
  });

  $$('.result-row').forEach((row) => row.classList.toggle('sel', row.dataset.id === v.id));
}

function closeDrawer(restore = true) {
  const drawer = $('#drawer');
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  document.body.classList.remove('drawer-open');
  if (restore && location.hash.startsWith('#/viveiro/')) {
    history.replaceState(null, '', state.drawerFrom || '#/viveiros');
  }
}

function copyLink() {
  const url = location.href;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copiado.'), () => toast('Não foi possível copiar o link.', 'error'));
  } else {
    toast('Copie o endereço da barra do navegador.');
  }
}

function downloadGeoJSON(list, filename) {
  if (!list.length) {
    toast('Nenhum viveiro para baixar.', 'error');
    return;
  }
  const fc = {
    type: 'FeatureCollection',
    features: list.map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      properties: {
        id: v.id,
        nome: v.nome,
        categoria: v.categoria,
        beneficiario: v.beneficiario,
        municipio: v.municipio,
        codigo_ibge: v.codigo_ibge,
        regiao: v.regiao,
        regiao_oficial: v.regiao_oficial,
        unidade: v.unidade,
        dimensoes: v.dimensoes_raw,
        largura_m: v.largura_m,
        comprimento_m: v.comprimento_m,
        area_m2: v.area_m2,
        capacidade: v.capacidade,
        capacidade_faixa: v.capacidade_faixa,
        uc_nome: v.uc_nome,
        uc_grupo: v.uc_grupo,
        lat: v.lat,
        lon: v.lon,
      },
    })),
  };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast(`${list.length} viveiro${list.length === 1 ? '' : 's'} baixado${list.length === 1 ? '' : 's'}.`);
}

/* ------------------------------------------------------------------ */
/* Eventos globais                                                     */
/* ------------------------------------------------------------------ */
function bindGlobal() {
  $('#theme-toggle')?.addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  $('#drawer')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) closeDrawer(true);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer(true);
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#/viveiro/"]');
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const id = link.getAttribute('href').split('?')[0].split('/').pop();
    if (id) openDrawer(id, { push: true });
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
}

/* ------------------------------------------------------------------ */
/* Início                                                              */
/* ------------------------------------------------------------------ */
async function init() {
  setTheme(localStorage.getItem(THEME_KEY) || 'light');
  bindGlobal();
  try {
    await loadData();
    route();
  } catch (error) {
    console.error(error);
    $('#app').innerHTML = `<div class="wrap" style="padding:60px 0"><h1>Não foi possível carregar o guia</h1><p class="muted">${esc(error.message)}</p></div>`;
  }
}

init();
