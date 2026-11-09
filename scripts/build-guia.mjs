/**
 * Pipeline do Guia dos Viveiros.
 *
 * Lê os GeoJSON originais de data/, normaliza os atributos, faz o join
 * espacial com municípios e UCs estaduais, calcula os agregados e gera:
 *   assets/data/viveiros.json
 *   assets/data/{municipios,ucs_estaduais,regioes_integracao,estado}.geojson
 *
 * Uso: node scripts/build-guia.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'assets', 'data');
const DATA_ONLY = process.argv.includes('--data-only');

fs.mkdirSync(OUT, { recursive: true });

const read = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const strip = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

const slugify = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const ACRONYMS = new Set([
  'COM', 'PA', 'PAEX', 'PDS', 'RESEX', 'CFR', 'STTR', 'IFPA', 'UFOPA',
  'IDEFLORBIO', 'SEMAGRI', 'SEMMA', 'SEMA', 'EMATER', 'UDB', 'DDF',
  'ER', 'ERBA', 'ATX', 'APROFIRMA', 'AGROADA', 'TNC', 'CEPLAC', 'UFRA',
  'UNIFESPA', 'UFPA', 'EETEPA', 'APISAL', 'COAPEMI', 'ASB', 'SEMPA',
  'M.', 'GOELDI', 'BR', 'KM', 'AMPPF', 'UNIFESSPA', 'UDB', 'SEAGRI',
]);

function titleCase(value) {
  return String(value ?? '')
    .trim()
    .split(/(\s+|\/)/)
    .map((part) => {
      if (!part || part === '/' || /^\s+$/.test(part)) return part;
      const match = part.match(/^([A-Za-zÀ-ÿ0-9.]+)(.*)$/);
      if (!match) return part;
      const [, word, suffix] = match;
      const bare = word.replace(/\.$/, '');
      const upper = bare.toUpperCase();
      if (ACRONYMS.has(upper) || upper.length <= 3) return upper + (word.endsWith('.') ? '.' : '') + suffix;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + suffix;
    })
    .join('');
}

const REGION_LABELS = {
  'REGIONAL XINGU': 'Xingu',
  ARAGUAIA: 'Araguaia',
  'RIO CAPIM': 'Rio Capim',
  MARAJO: 'Marajó',
  CAETE: 'Caeté',
  GUAMA: 'Guamá',
  GUAJARA: 'Guajará',
  'LAGO DE TUCURUI': 'Lago de Tucuruí',
  CARAJAS: 'Carajás',
  'BAIXO AMAZONAS': 'Baixo Amazonas',
  TOCANTINS: 'Tocantins',
  TAPAJOS: 'Tapajós',
};

const UNIDADE_LABELS = {
  DDF: 'DDF',
  'ER CARAJAS': 'ER Carajás',
  'ER XINGU': 'ER Xingu',
  'ERBA I': 'ERBA I',
};

const regionLabel = (value) => REGION_LABELS[strip(value)] || titleCase(value);

function capacityRange(capacity) {
  if (capacity === null || capacity === undefined || Number.isNaN(capacity)) return 'Sem informação';
  if (capacity <= 5000) return 'Até 5 mil';
  if (capacity <= 15000) return '5 a 15 mil';
  if (capacity <= 50000) return '15 a 50 mil';
  return 'Acima de 50 mil';
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseDimensions(value) {
  const nums = String(value ?? '').match(/\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length < 2) {
    return { largura_m: null, comprimento_m: null, area_m2: null };
  }
  const a = Number(nums[0].replace(',', '.'));
  const b = Number(nums[1].replace(',', '.'));
  if (!a || !b) return { largura_m: null, comprimento_m: null, area_m2: null };
  return {
    largura_m: Math.min(a, b),
    comprimento_m: Math.max(a, b),
    area_m2: Math.round(a * b * 100) / 100,
  };
}

/* ------------------------------------------------------------------ */
/* Point in polygon                                                    */
/* ------------------------------------------------------------------ */
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i += 1) {
    if (pointInRing(point, polygon[i])) return false;
  }
  return true;
}

function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Dados de origem                                                     */
/* ------------------------------------------------------------------ */
const viveirosFC = read('viveiros.geojson');
const municipiosFC = read('municipios.geojson');
const ucsFC = read('ucs_estaduais.geojson');
const regioesFC = read('regioes_integracao.geojson');
const estadoFC = read('estado.geojson');

const municipios = municipiosFC.features.map((feature) => {
  const p = feature.properties || {};
  return {
    nome: p.NM_MUN,
    nome_normalizado: strip(p.NM_MUN),
    codigo_ibge: p.CD_MUN,
    regiao: p['Região de Integração'] || p.NM_RGINT || '',
    geometry: feature.geometry,
  };
});

const ucs = ucsFC.features.map((feature) => {
  const p = feature.properties || {};
  return {
    nome: p.NOME_,
    grupo: p.GRUPO,
    categoria: p.CATEGORIA,
    geometry: feature.geometry,
  };
});

const municipioIndex = new Map(municipios.map((m) => [m.nome_normalizado, m]));

const MUNICIPIO_ALIASES = {
  'PEIXE BOI': 'PEIXE-BOI',
  'ELDORADO DOS CARAJAS': 'ELDORADO DO CARAJAS',
  'VIGIA DE NAZARE': 'VIGIA',
  'TOME ACU': 'TOME-ACU',
};

const UC_SHORT = [
  [/^Área de Proteção Ambiental /i, 'APA '],
  [/^Floresta Estadual /i, 'Flota '],
  [/^Parque Estadual /i, 'PE '],
  [/^Reserva de Desenvolvimento Sustentável /i, 'RDS '],
  [/^Reserva Biológica /i, 'Rebio '],
  [/^Estação Ecológica /i, 'Esec '],
  [/^Refúgio de Vida Silvestre /i, 'Revis '],
  [/^Monumento Natural /i, 'Mona '],
];

function shortUc(name) {
  if (!name) return null;
  let value = name;
  for (const [pattern, replacement] of UC_SHORT) value = value.replace(pattern, replacement);
  return value;
}

/* ------------------------------------------------------------------ */
/* Normalização dos viveiros                                          */
/* ------------------------------------------------------------------ */
const viveiros = [];
const avisos = [];

viveirosFC.features.forEach((feature, index) => {
  if (!feature?.geometry?.coordinates) return;
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry.coordinates;

  const municipioRaw = String(p['Município'] ?? '').trim();
  const municipioLookup = MUNICIPIO_ALIASES[strip(municipioRaw)] || strip(municipioRaw);
  const municipioOficial = municipioIndex.get(municipioLookup);
  if (!municipioOficial && municipioRaw) {
    avisos.push(`Município sem correspondência: ${municipioRaw}`);
  }

  const regiaoRaw = String(p['Região de integração'] ?? '').trim();
  const categoriaRaw = String(p['Categoria de viveiro'] ?? '').trim();
  const categoria = strip(categoriaRaw) === 'COMUNITARIO' ? 'Comunitário' : 'Institucional';
  const beneficiarioRaw = String(p['Beneficiário'] ?? '').trim();
  const unidade = UNIDADE_LABELS[strip(p['Unidade responsável'])] || titleCase(String(p['Unidade responsável'] ?? '').trim());
  const capacidade = parseNumber(p['Capacidade de produção']);
  const dimensoes = parseDimensions(p['Dimensões']);

  const municipio = municipioOficial?.nome || titleCase(municipioRaw);
  const regiao = regionLabel(regiaoRaw);

  const point = [lon, lat];
  const ucsDoPonto = ucs.filter((uc) => pointInGeometry(point, uc.geometry));
  const uc = ucsDoPonto[0] || null;

  const beneficiario = titleCase(beneficiarioRaw).replace(/\s*\/\s*/g, '/');
  const id = `v-${String(index + 1).padStart(3, '0')}`;
  const nome = beneficiario
    ? `Viveiro ${categoria.toLowerCase()} · ${beneficiario} · ${municipio}`
    : `Viveiro ${categoria.toLowerCase()} · ${municipio}`;

  viveiros.push({
    id,
    nome,
    categoria,
    beneficiario,
    beneficiario_raw: beneficiarioRaw,
    municipio,
    municipio_slug: municipioOficial ? slugify(municipioOficial.nome) : slugify(municipioRaw),
    codigo_ibge: municipioOficial?.codigo_ibge || null,
    regiao,
    regiao_slug: slugify(regiao),
    regiao_oficial: (municipioOficial?.regiao || '').replace(/^RI\s+/i, ''),
    unidade,
    dimensoes_raw: String(p['Dimensões'] ?? '').trim(),
    largura_m: dimensoes.largura_m,
    comprimento_m: dimensoes.comprimento_m,
    area_m2: dimensoes.area_m2,
    capacidade,
    capacidade_faixa: capacityRange(capacidade),
    uc_nome: uc?.nome || null,
    uc_nome_curto: shortUc(uc?.nome),
    uc_grupo: uc?.grupo || null,
    uc_categoria: uc?.categoria || null,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
  });
});

/* ------------------------------------------------------------------ */
/* Agregados                                                           */
/* ------------------------------------------------------------------ */
function aggregate(list, keyFn, build) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (key === null || key === undefined || key === '') continue;
    let entry = map.get(key);
    if (!entry) {
      entry = build(item);
      map.set(key, entry);
    }
    entry.viveiros += 1;
    entry.capacidade += item.capacidade || 0;
    if (item.categoria === 'Comunitário') entry.comunitarios += 1;
    else entry.institucionais += 1;
    if (item.uc_nome) entry.em_uc += 1;
  }
  return [...map.values()].sort((a, b) => b.viveiros - a.viveiros || b.capacidade - a.capacidade);
}

const vazio = { viveiros: 0, capacidade: 0, comunitarios: 0, institucionais: 0, em_uc: 0 };

const porRegiao = aggregate(
  viveiros,
  (v) => v.regiao,
  (v) => ({ nome: v.regiao, slug: v.regiao_slug, ...vazio })
);

const porMunicipio = aggregate(
  viveiros,
  (v) => v.municipio,
  (v) => ({
    nome: v.municipio,
    slug: v.municipio_slug,
    codigo_ibge: v.codigo_ibge,
    regiao: v.regiao,
    regiao_oficial: v.regiao_oficial,
    ...vazio,
  })
);

const porUnidade = aggregate(
  viveiros,
  (v) => v.unidade,
  (v) => ({ nome: v.unidade, ...vazio })
);

const porCategoria = aggregate(
  viveiros,
  (v) => v.categoria,
  (v) => ({ nome: v.categoria, ...vazio })
);

const porUc = aggregate(
  viveiros,
  (v) => v.uc_nome,
  (v) => ({
    nome: v.uc_nome,
    nome_curto: v.uc_nome_curto,
    slug: slugify(v.uc_nome),
    grupo: v.uc_grupo,
    categoria: v.uc_categoria,
    ...vazio,
  })
);

const faixas = [
  { nome: 'Até 5 mil', viveiros: 0 },
  { nome: '5 a 15 mil', viveiros: 0 },
  { nome: '15 a 50 mil', viveiros: 0 },
  { nome: 'Acima de 50 mil', viveiros: 0 },
  { nome: 'Sem informação', viveiros: 0 },
];
for (const v of viveiros) {
  const faixa = faixas.find((f) => f.nome === v.capacidade_faixa);
  if (faixa) faixa.viveiros += 1;
}

const totalCapacidade = viveiros.reduce((sum, v) => sum + (v.capacidade || 0), 0);
const municipiosComViveiros = new Set(viveiros.map((v) => v.municipio)).size;
const regioesComViveiros = new Set(viveiros.map((v) => v.regiao)).size;
const ucsComViveiros = new Set(viveiros.map((v) => v.uc_nome).filter(Boolean)).size;

const totals = {
  viveiros: viveiros.length,
  capacidade: totalCapacidade,
  municipios: municipiosComViveiros,
  regioes: regioesComViveiros,
  ucs: ucsComViveiros,
  em_uc: viveiros.filter((v) => v.uc_nome).length,
  comunitarios: viveiros.filter((v) => v.categoria === 'Comunitário').length,
  institucionais: viveiros.filter((v) => v.categoria === 'Institucional').length,
};

const payload = {
  gerado_em: new Date().toISOString(),
  fonte: {
    base: 'data/viveiros.geojson',
    manual: 'Manual de Viveiro de Mudas, IDEFLOR-Bio, 2020',
    pagina: 'https://ideflorbio.pa.gov.br/projeto-prosaf/',
  },
  totals,
  agregados: {
    por_regiao: porRegiao,
    por_municipio: porMunicipio,
    por_unidade: porUnidade,
    por_categoria: porCategoria,
    por_uc: porUc,
    faixas,
  },
  avisos: [...new Set(avisos)],
  viveiros,
};

fs.writeFileSync(path.join(OUT, 'viveiros.json'), JSON.stringify(payload));
console.log(`viveiros.json: ${(fs.statSync(path.join(OUT, 'viveiros.json')).size / 1024).toFixed(1)} KB`);
console.log(`  ${totals.viveiros} viveiros · ${totals.municipios} municípios · ${totals.regioes} regiões`);
console.log(`  ${totals.comunitarios} comunitários · ${totals.institucionais} institucionais · ${totals.em_uc} em UCs`);
console.log(`  capacidade declarada: ${totals.capacidade.toLocaleString('pt-BR')}`);

/* ------------------------------------------------------------------ */
/* Simplificação das camadas de contexto                              */
/* ------------------------------------------------------------------ */
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function simplify(input, output, percent, fields, keepShapes = false) {
  const q = (value) => `"${value}"`;
  const args = ['--yes', 'mapshaper', q(path.join(DATA, input)), '-simplify', `${percent}%`];
  if (keepShapes) args.push('keep-shapes');
  if (fields) args.push('-filter-fields', fields);
  args.push('-o', q(path.join(OUT, output)));
  console.log(`\nmapshaper ${input} -> ${output}`);
  const result = spawnSync(npx, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`Falha ao simplificar ${input}`);
  }
  console.log(`${output}: ${(fs.statSync(path.join(OUT, output)).size / 1024).toFixed(1)} KB`);
}

if (!DATA_ONLY) {
  simplify('municipios.geojson', 'municipios.geojson', 5, 'NM_MUN,CD_MUN,NM_mai');
  simplify('ucs_estaduais.geojson', 'ucs_estaduais.geojson', 4, 'NOME_,GRUPO,CATEGORIA', true);
  simplify('regioes_integracao.geojson', 'regioes_integracao.geojson', 5, null);
  simplify('estado.geojson', 'estado.geojson', 4, null);

  /* ------------------------------------------------------------------ */
  /* Sitemap                                                            */
  /* ------------------------------------------------------------------ */
  const baseUrl = 'https://ngeo-ideflor-bio.github.io/viveiros-ideflorbio/';
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    '',
    '#/viveiros',
    '#/entenda',
    '#/montagem',
    '#/fontes',
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${baseUrl}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
  console.log('\nsitemap.xml atualizado');
} else {
  console.log('\nmodo --data-only: camadas de contexto e sitemap não foram regerados');
}
