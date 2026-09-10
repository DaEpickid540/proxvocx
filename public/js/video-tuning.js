/**
 * Encoder tuning for the PC Control screen share.
 *
 * Handed a screen-capture track and nothing else, Chromium codes it like
 * camera video. That default costs three things at once, and together they are
 * why the picture arrives soft *and* stuttery no matter what is on screen:
 *
 *   1. No `contentHint`, so libvpx never turns on its screen-content mode —
 *      the mode that exists precisely because UI is flat colour, hard edges and
 *      long stretches of nothing moving. Text gets coded as if it were skin.
 *   2. A `degradationPreference` of "balanced", which shed resolution *and*
 *      frame rate at the first sign of congestion rather than picking one.
 *   3. A rate controller that opens at 300 kbps and, for a screen share,
 *      tops out around 2.5 Mbps — nowhere near enough for a 1080p desktop, and
 *      slow enough to climb that the first several seconds are a blur.
 *
 * Everything here is one of those three: a hint, a bitrate ceiling sized to the
 * actual picture, and a small amount of SDP so the session does not have to
 * discover the link from scratch.
 */

/**
 * How the encoder should spend a bitrate it cannot stretch to cover
 * everything. Reading a desktop wants every pixel of the text even if the
 * frame rate sags; a game wants the opposite.
 *
 * `maintain-resolution` is worth reading as what it actually is: a standing
 * refusal to ever send a smaller picture. When the link cannot carry 1080p60
 * of screen content — which ordinary wifi frequently cannot — the encoder's
 * only remaining answer is to send fewer frames, so the picture stays
 * pin-sharp and moves in lurches. That is the right trade for reading a page
 * and the wrong one for using a desktop, hence `balanced` sitting between the
 * two rather than a choice between two extremes.
 */
export const STREAM_MODES = {
  text: {
    label: 'Sharp text — best for reading, editors, browsing',
    contentHint: 'text',
    degradationPreference: 'maintain-resolution',
  },
  balanced: {
    label: 'Balanced — sharp when it can be, smooth when it can’t',
    contentHint: 'text',
    degradationPreference: 'balanced',
  },
  motion: {
    label: 'Smooth motion — best for video and games',
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
  },
};

/**
 * Codec order to ask for. VP9 carries screen content markedly better than VP8
 * at the same bitrate (it has the screen-content tools VP8 lacks), but it is
 * encoded in software, so a modest PC pushing 1440p60 can run out of CPU and
 * start dropping frames — which is the one failure this whole file exists to
 * avoid. H.264 is the other way round: hardware-encoded on essentially every
 * Windows GPU, so it is cheap and smooth, and merely soft rather than sharp.
 * Hence a choice, not a hardcoded winner.
 */
export const CODEC_ORDERS = {
  auto: ['video/VP9', 'video/H264', 'video/VP8'],
  sharp: ['video/VP9', 'video/VP8', 'video/H264'],
  smooth: ['video/H264', 'video/VP9', 'video/VP8'],
};

/* Screen content compresses far better than camera video, so the per-pixel
   budget is well under what a camera would need. This is a ceiling, not a
   target: congestion control still decides what is actually sent, and a static
   desktop will sit far below it. */
const BITS_PER_PIXEL_PER_FRAME = 0.06;
const MIN_MAX_BITRATE = 1_500_000;
const MAX_MAX_BITRATE = 25_000_000;
/* Below this the ceiling stops tracking frame rate. A 15 or 20 fps stream of
   text is not a stream that needs fewer bits per frame — the frames that do
   change during a scroll change wholesale, and scaling the budget linearly
   down with the rate is what makes a slow, sharp stream impossible to ask
   for. */
const MIN_EFFECTIVE_FPS = 30;

/* Codecs that carry picture. RTX/RED/ULPFEC ride along in the same m-section
   and must never be given bitrate hints or promoted in the preference list. */
const MEDIA_CODECS = /^video\/(VP8|VP9|H264|H265|AV1)$/i;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * A bitrate ceiling that matches the picture being sent. Left unset, a screen
 * share is capped around 2.5 Mbps — fine for a slide deck, visibly mushy for a
 * 1080p desktop full of small text.
 */
export function bitrateFor({ width, height, frameRate }) {
  const pixels = (Number(width) || 1920) * (Number(height) || 1080);
  const fps = Math.max(Number(frameRate) || 30, MIN_EFFECTIVE_FPS);
  return Math.round(clamp(pixels * fps * BITS_PER_PIXEL_PER_FRAME, MIN_MAX_BITRATE, MAX_MAX_BITRATE));
}

/**
 * Applies the content hint, the degradation preference and the bitrate ceiling
 * to a live video sender. Safe to call again at any point — `recapture()` does
 * exactly that, because `replaceTrack()` carries the sender's parameters over
 * but not the hint, which belongs to the track that was just swapped out.
 */
export async function tuneSender(sender, { mode = 'text', frameRate = 30, maxBitrate } = {}) {
  if (!sender) return;
  const profile = STREAM_MODES[mode] || STREAM_MODES.text;

  if (sender.track) sender.track.contentHint = profile.contentHint;

  const params = sender.getParameters();
  params.degradationPreference = profile.degradationPreference;
  if (!params.encodings?.length) params.encodings = [{}];
  for (const encoding of params.encodings) {
    encoding.active = true;
    encoding.maxBitrate = maxBitrate;
    encoding.maxFramerate = frameRate;
    // A *base* downscale applied before the encoder sees the frame — not a
    // limit on congestion adaptation, which is `degradationPreference`'s job
    // and happens on top of this. 1 means "start from the real resolution".
    encoding.scaleResolutionDownBy = 1;
    encoding.networkPriority = 'high';
    encoding.priority = 'high';
  }
  await sender.setParameters(params);
}

/**
 * Reorders the codecs offered for this transceiver. Called before
 * `createOffer()`, so the preference lands in the offer's m-line and the
 * viewer simply answers with the first one it can decode.
 */
export function preferCodecs(transceiver, codecOrder = CODEC_ORDERS.auto) {
  if (!transceiver?.setCodecPreferences || !globalThis.RTCRtpSender?.getCapabilities) return;
  const supported = RTCRtpSender.getCapabilities('video')?.codecs;
  if (!supported?.length) return;

  const rank = (codec) => {
    const index = codecOrder.findIndex((name) => name.toLowerCase() === codec.mimeType.toLowerCase());
    return index === -1 ? codecOrder.length : index;
  };
  // A stable sort, so RTX and the FEC codecs keep their relative order behind
  // the media codecs instead of being dropped — Chromium needs them present.
  const ordered = [...supported].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(ordered);
  } catch {
    /* An unsupported ordering is not worth failing the session over — the
       default order still produces a working, if less sharp, stream. */
  }
}

/**
 * Writes bitrate hints into the *answer* before it is applied.
 *
 * These are read by the encoder out of its remote description, which is why
 * this belongs on the answer the host receives rather than the offer it sent.
 * `start` is the one that matters most in practice: without it every session
 * opens at 300 kbps and spends its first several seconds climbing, which is
 * precisely the window in which someone forms the opinion that the stream
 * looks bad.
 */
export function applyBitrateHints(sdp, { maxBitrate }) {
  const maxKbps = Math.round(maxBitrate / 1000);
  // Open at a third of the ceiling — high enough to be legible immediately,
  // low enough that a genuinely thin link corrects downward within a second or
  // two instead of drowning. The floor keeps text readable rather than letting
  // a brief dip collapse the picture into blocks.
  const startKbps = Math.round(maxKbps / 3);
  const minKbps = 600;

  // An SDP ends with a line terminator, so splitting leaves a trailing empty
  // entry. Dropping it here and re-adding exactly one below keeps the rewrite
  // idempotent instead of growing a blank line on every pass.
  const lines = sdp.split(/\r\n|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let inVideo = false;
  /** payload type -> true, for the media codecs in the video section */
  const mediaPayloads = new Set();

  // First pass: work out which payload types in the video m-section are actual
  // codecs rather than retransmission or FEC.
  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    if (!inVideo) continue;
    const rtpmap = /^a=rtpmap:(\d+) ([^/]+\/\d+)/.exec(line);
    if (rtpmap && MEDIA_CODECS.test(`video/${rtpmap[2].split('/')[0]}`)) mediaPayloads.add(rtpmap[1]);
  }

  inVideo = false;
  const hinted = new Set();
  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video');
      out.push(line);
      continue;
    }
    if (!inVideo) {
      out.push(line);
      continue;
    }

    // b=AS goes immediately after the connection line of the video section.
    if (line.startsWith('c=')) {
      out.push(line, `b=AS:${maxKbps}`, `b=TIAS:${maxBitrate}`);
      continue;
    }
    // Any bandwidth line the answerer supplied is replaced by ours above.
    if (line.startsWith('b=')) continue;

    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp && mediaPayloads.has(fmtp[1])) {
      hinted.add(fmtp[1]);
      const existing = stripHints(fmtp[2]);
      const hints = hintParams(startKbps, minKbps, maxKbps);
      out.push(`a=fmtp:${fmtp[1]} ${existing ? `${existing};${hints}` : hints}`);
      continue;
    }
    out.push(line);
  }

  // VP8 usually arrives with no fmtp line at all, so there was nothing to
  // append to — give it one.
  const withMissing = [];
  inVideo = false;
  for (const line of out) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    withMissing.push(line);
    const rtpmap = /^a=rtpmap:(\d+) /.exec(line);
    if (inVideo && rtpmap && mediaPayloads.has(rtpmap[1]) && !hinted.has(rtpmap[1])) {
      withMissing.push(`a=fmtp:${rtpmap[1]} ${hintParams(startKbps, minKbps, maxKbps)}`);
    }
  }

  return `${withMissing.join('\r\n')}\r\n`;
}

const hintParams = (startKbps, minKbps, maxKbps) =>
  `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;

/** Drops any hints already present so re-applying cannot stack duplicates. */
const stripHints = (params) =>
  params
    .split(';')
    .filter((p) => !/^x-google-(start|min|max)-bitrate=/.test(p.trim()))
    .join(';')
    .replace(/^;+|;+$/g, '');
