// Reads lead files in the browser: Meta Leads Center exports (ZIP of UTF-16 tab-separated CSVs), plain CSV/TSV
// in any common encoding, and Excel .xlsx. No libraries: ZIP via DecompressionStream, XLSX via DOMParser.
// readLeadFiles(fileList) -> { rows: [{external_id, created_time, name, phone, email, city, ...extra}], files: [...], skipped: n }

// ---------- ZIP ----------
async function inflate(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error('Unsupported compression in ZIP');
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}
export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.push({ name, data: await inflate(u8.subarray(start, start + size), method) });
  }
  return out;
}

// ---------- Text / CSV ----------
function decodeText(u8) {
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder().decode(u8.subarray(3));
  // UTF-16 without BOM: every other byte is zero
  if (u8.length > 3 && u8[1] === 0 && u8[3] === 0) return new TextDecoder('utf-16le').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { return new TextDecoder('windows-1252').decode(u8); }
}
function parseDelimited(text) {
  const first = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length);
  const delim = [['\t', (first.match(/\t/g) || []).length], [',', (first.match(/,/g) || []).length], [';', (first.match(/;/g) || []).length]]
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// ---------- XLSX (first sheet) ----------
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
async function parseXlsx(buf) {
  const files = Object.fromEntries((await unzip(buf)).map((f) => [f.name, f.data]));
  const xml = (name) => (files[name] ? new DOMParser().parseFromString(new TextDecoder().decode(files[name]), 'application/xml') : null);
  const shared = [...(xml('xl/sharedStrings.xml')?.getElementsByTagName('si') || [])].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  // First sheet listed in the workbook (falls back to sheet1.xml)
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = xml('xl/workbook.xml'), rels = xml('xl/_rels/workbook.xml.rels');
  const firstSheet = wb?.getElementsByTagName('sheet')[0];
  if (firstSheet && rels) {
    const rid = firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rel = [...rels.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
    if (rel) sheetPath = 'xl/' + rel.getAttribute('Target').replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const sheet = xml(sheetPath);
  if (!sheet) throw new Error('Could not read the first sheet of the Excel file');
  const rows = [];
  for (const r of sheet.getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      const val = t === 's' ? shared[+v] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map((x) => x.textContent).join('') : v;
      row[colIndex(c.getAttribute('r') || 'A1')] = val;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
const excelDate = (n) => new Date(Math.round((Number(n) - 25569) * 86400000) - 330 * 60000).toISOString(); // serial (IST) -> ISO

// ---------- Map a sheet to leads ----------
const norm = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const ALIAS = {
  name: ['full_name', 'name', 'your_name', 'customer_name', 'lead_name'],
  first_name: ['first_name', 'firstname'], last_name: ['last_name', 'lastname', 'surname'],
  phone: ['phone_number', 'phone', 'mobile', 'mobile_number', 'whatsapp_number', 'whatsapp', 'contact_number', 'contact'],
  email: ['email', 'email_address', 'e_mail'],
  city: ['city', 'current_city', 'your_city', 'location'],
  interest: ['interest', 'course', 'program', 'interested_in'],
  message: ['message', 'notes', 'comments', 'query', 'enquiry'],
  campaign: ['campaign_name', 'campaign'], adset: ['adset_name', 'ad_set_name', 'adset'], ad: ['ad_name', 'ad'], form: ['form_name', 'form'],
  platform: ['platform'], created_time: ['created_time', 'created_at', 'created'],
  external_id: ['id', 'lead_id', 'leadgen_id'],
};
// Meta's internal ids and flags that are not useful on a lead.
const DROP = new Set(['ad_id', 'adset_id', 'campaign_id', 'form_id', 'phone_number_verified', 'lead_status', 'inbox_url', 'retailer_item_id', 'vehicle', 'is_organic']);
const PLATFORM = { ig: 'instagram', fb: 'facebook', an: 'audience network', ms: 'messenger', wa: 'whatsapp' };
// "never,_but_interested" -> "never, but interested"
const tidy = (v) => String(v ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function mapSheet(table) {
  if (table.length < 2) return [];
  const head = table[0].map(norm);
  const used = new Map();
  for (const [field, names] of Object.entries(ALIAS)) {
    const i = names.map((n) => head.indexOf(n)).find((x) => x >= 0);
    if (i != null && i >= 0 && ![...used.values()].includes(i)) used.set(field, i);
  }
  // A plain "id" column only counts as a lead id when it looks like Meta's "l:123…".
  if (used.has('external_id') && head[used.get('external_id')] === 'id' && !table.slice(1, 6).some((r) => /^l:\d+/.test(String(r[used.get('external_id')] || '')))) used.delete('external_id');
  const usedIdx = new Set(used.values());
  return table.slice(1).map((r) => {
    const get = (f) => (used.has(f) ? String(r[used.get(f)] ?? '').trim() : '');
    const o = {};
    const ext = get('external_id').replace(/^l:/, '');
    if (ext) o.external_id = ext;
    let ct = get('created_time');
    if (ct && /^\d+(\.\d+)?$/.test(ct)) ct = excelDate(ct);
    if (ct) o.created_time = ct;
    o.name = get('name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ');
    o.phone = get('phone').replace(/^p:/, '');
    o.email = get('email');
    for (const f of ['city', 'interest', 'message', 'campaign', 'adset', 'ad', 'form']) { const v = get(f); if (v) o[f] = v; }
    const pl = get('platform').toLowerCase();
    if (pl) o.platform = PLATFORM[pl] || pl;
    const extra = {};
    head.forEach((h, i) => {
      if (usedIdx.has(i) || DROP.has(h) || !h) return;
      const v = tidy(r[i]);
      if (v && v !== 'false') extra[h.replace(/_+$/, '')] = v;
    });
    if (Object.keys(extra).length) o.extra = extra;
    return o;
  });
}

export async function readLeadFiles(fileList) {
  const tables = [];
  for (const file of fileList) {
    const lower = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    if (lower.endsWith('.zip')) {
      for (const f of await unzip(buf)) {
        const n = f.name.toLowerCase();
        if (/\.(csv|tsv|txt)$/.test(n)) tables.push({ name: f.name, rows: parseDelimited(decodeText(f.data)) });
        else if (n.endsWith('.xlsx')) tables.push({ name: f.name, rows: await parseXlsx(f.data.slice().buffer) });
      }
    } else if (lower.endsWith('.xlsx')) tables.push({ name: file.name, rows: await parseXlsx(buf) });
    else if (lower.endsWith('.xls')) throw new Error(`${file.name}: old .xls files can't be read — open it in Excel and "Save as" .xlsx or .csv`);
    else tables.push({ name: file.name, rows: parseDelimited(decodeText(new Uint8Array(buf))) });
  }
  if (!tables.length) throw new Error('No CSV or Excel file found inside');
  const rows = [], files = [];
  let skipped = 0;
  const seen = new Set();
  for (const t of tables) {
    const mapped = mapSheet(t.rows);
    files.push({ name: t.name.split('/').pop(), rows: mapped.length });
    for (const o of mapped) {
      if (!o.phone && !o.email) { skipped++; continue; }
      // Same lead twice inside the upload (e.g. overlapping exports): keep the first.
      const key = o.external_id ? 'id:' + o.external_id : 'pe:' + (o.phone || '').replace(/\D/g, '').slice(-10) + '|' + (o.email || '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(o);
    }
  }
  return { rows, files, skipped };
}
