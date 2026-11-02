export const HELPER_URL = 'http://127.0.0.1:39841';
const HELPER_SERVICE = 'melody-tab-youtube-helper';

export function defaultYouTubeSource(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? 'server' : 'helper';
}

export function youtubeRequestUrl(videoUrl, source) {
  return `${source === 'helper' ? HELPER_URL : ''}/api/youtube?url=${encodeURIComponent(videoUrl)}`;
}

export async function checkYouTubeHelper(fetchRequest = fetch) {
  let response;
  try {
    response = await fetchRequest(`${HELPER_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('ยังเชื่อมต่อตัวช่วยไม่ได้ — เปิด start-youtube-helper.cmd บนคอมเครื่องนี้ และอนุญาตการเข้าถึงเครือข่ายในเครื่องหากเบราว์เซอร์ถาม แล้วลองอีกครั้ง');
  }
  if (!response.ok) throw new Error('ตัวช่วยไม่อนุญาตให้เว็บนี้เชื่อมต่อ — โปรดอัปเดตตัวช่วยเป็นเวอร์ชันล่าสุด');
  const health = await response.json().catch(() => null);
  if (health?.service !== HELPER_SERVICE || health?.version !== 1) {
    throw new Error('โปรแกรมที่พอร์ตตัวช่วยไม่ใช่เวอร์ชันที่รองรับ — เปิดตัวช่วย Melody Tab เวอร์ชันล่าสุด');
  }
  if (health.busy) throw new Error('ตัวช่วยกำลังดึงเสียงให้แท็บอื่นอยู่ — รอให้เสร็จแล้วลองใหม่');
  return health;
}
