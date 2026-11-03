export const HELPER_URL = 'http://127.0.0.1:39841';
export const LOCAL_SERVER_URL = 'http://127.0.0.1:39842';
const HELPER_SERVICE = 'melody-tab-youtube-helper';

export function youtubePreviewUrl(value, range) {
  let videoId;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (url.hostname === 'youtu.be') videoId = url.pathname.slice(1).split('/')[0];
    else if (/(^|\.)youtube\.com$/.test(url.hostname)) {
      videoId = url.pathname === '/watch' ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/)?.[1];
    }
    if (!/^[\w-]{11}$/.test(videoId || '')) throw new Error();
  } catch { throw new Error('วางลิงก์ YouTube ที่ถูกต้องก่อนฟังช่วงที่เลือก'); }
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  embed.searchParams.set('start', Math.floor(range.start));
  if (Number.isFinite(range.end)) embed.searchParams.set('end', Math.ceil(range.end));
  embed.searchParams.set('autoplay', '1');
  embed.searchParams.set('playsinline', '1');
  embed.searchParams.set('rel', '0');
  return embed.href;
}

export function defaultYouTubeSource(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? 'server' : 'home';
}

export async function checkLocalServer(fetchRequest = fetch) {
  let response;
  try { response = await fetchRequest(`${LOCAL_SERVER_URL}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('เปิด start-youtube-helper.cmd บนคอมเครื่องนี้ค้างไว้ และอนุญาตให้หน้า GitHub เข้าถึงเครือข่ายในเครื่อง (Local network) หากเบราว์เซอร์ถาม แล้วลองแกะอีกครั้ง'); }
  const health = response.ok ? await response.json().catch(() => null) : null;
  if (health?.service !== 'melody-tab' || health?.version !== 1) throw new Error('เซิร์ฟเวอร์ยังไม่พร้อมเชื่อมต่อเว็บนี้ — ปิดแล้วเปิด Home Server เวอร์ชันล่าสุดใหม่');
  return LOCAL_SERVER_URL;
}

export function youtubeRequestUrl(videoUrl, source) {
  const base = source === 'home' ? LOCAL_SERVER_URL : source === 'helper' ? HELPER_URL : '';
  return `${base}/api/youtube?url=${encodeURIComponent(videoUrl)}`;
}

export async function checkYouTubeHelper(fetchRequest = fetch) {
  let response;
  try {
    response = await fetchRequest(`${HELPER_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('เปิด start-youtube-helper.cmd แล้วกด Open website ในหน้าต่างตัวช่วยเพื่อใช้หน้า GitHub');
  }
  if (!response.ok) throw new Error('ตัวช่วยไม่อนุญาตให้เว็บนี้เชื่อมต่อ — โปรดอัปเดตตัวช่วยเป็นเวอร์ชันล่าสุด');
  const health = await response.json().catch(() => null);
  if (health?.service !== HELPER_SERVICE || health?.version !== 1) {
    throw new Error('โปรแกรมที่พอร์ตตัวช่วยไม่ใช่เวอร์ชันที่รองรับ — เปิดตัวช่วย Melody Tab เวอร์ชันล่าสุด');
  }
  if (health.busy) throw new Error('ตัวช่วยกำลังดึงเสียงให้แท็บอื่นอยู่ — รอให้เสร็จแล้วลองใหม่');
  return health;
}
