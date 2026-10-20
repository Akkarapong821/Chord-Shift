// Quick sanity check that youtubei.js can fetch an audio stream on this
// machine (YouTube frequently changes things that break extractor libraries).
// Tries several InnerTube clients — some return direct URLs that skip the
// broken decipher path.
import { Innertube } from 'youtubei.js';

const yt = await Innertube.create();

for (const client of ['IOS', 'ANDROID', 'TV', 'WEB_EMBEDDED', 'YTMUSIC']) {
  try {
    const info = await yt.getBasicInfo('jNQXAC9IVRw', { client });
    const stream = await info.download({ type: 'audio', quality: 'best', client });
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > 50000) break; // enough to prove it streams
    }
    console.log(`${client}: OK — ${info.basic_info.title}, streamed ${bytes} bytes`);
  } catch (err) {
    console.log(`${client}: FAIL — ${err.message}`);
  }
}
