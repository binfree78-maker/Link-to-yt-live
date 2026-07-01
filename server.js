const express = require("express");
const session = require("express-session");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const PANEL_USER = process.env.PANEL_USER || "admin";
const PANEL_PASS = process.env.PANEL_PASS || "admin123";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

const COOKIE_FILE = "/tmp/youtube-cookies.txt";

app.use(express.json({ limit: "8mb" }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

let ffmpegProcess = null;
let restartTimer = null;
let stopRequested = false;

let cookiesStatus = {
  exists: false,
  ok: false,
  message: "Cookies not added yet",
  checkedAt: null,
  lines: 0,
  loginCookies: false,
};

let liveState = {
  running: false,
  starting: false,
  youtubeUrl: "",
  loop: true,
  quality: "720",
  startedAt: null,
  stoppedAt: null,
  lastError: "",
  logs: [],
  fps: 0,
  bitrate: "0 kbps",
  droppedFrames: 0,
};

function addLog(type, message) {
  const item = {
    time: new Date().toISOString(),
    type,
    message: String(message || "").slice(0, 900),
  };
  liveState.logs.unshift(item);
  liveState.logs = liveState.logs.slice(0, 80);
  console.log(`[${type}] ${item.message}`);
}

function isLoggedIn(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

function isValidYoutubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return ["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"].includes(host);
  } catch {
    return false;
  }
}

function normalizeCookieText(raw) {
  let text = String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();

  const originalLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const fixed = [];

  for (let line of originalLines) {
    if (!line) continue;

    if (line.startsWith("#")) {
      fixed.push(line);
      continue;
    }

    line = line.replace(/\s+/g, "\t");

    if (line.startsWith(".youtube.comTRUE")) {
      line = line.replace(".youtube.comTRUE", ".youtube.com\tTRUE");
    }
    if (line.startsWith(".youtube.comFALSE")) {
      line = line.replace(".youtube.comFALSE", ".youtube.com\tFALSE");
    }

    fixed.push(line);
  }

  let result = fixed.join("\n").trim();

  if (!result.includes("Netscape HTTP Cookie File")) {
    result = "# Netscape HTTP Cookie File\n# This is a generated file! Do not edit.\n\n" + result;
  }

  return result + "\n";
}

function validateCookiesText(cookieText) {
  const lines = cookieText.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const cookieLines = lines.filter((l) => !l.startsWith("#"));
  const youtubeLines = cookieLines.filter((l) => l.includes(".youtube.com") || l.startsWith("youtube.com"));

  if (!cookieText.includes("Netscape HTTP Cookie File")) {
    return { ok: false, message: "Netscape header পাওয়া যায়নি", lines: 0, loginCookies: false };
  }

  if (youtubeLines.length < 3) {
    return { ok: false, message: "YouTube cookie line খুব কম / ভুল format", lines: youtubeLines.length, loginCookies: false };
  }

  let invalidCount = 0;

  for (const line of youtubeLines) {
    const parts = line.split(/\t+/);
    if (parts.length < 7) invalidCount++;
  }

  if (invalidCount > 0) {
    return {
      ok: false,
      message: `Cookie format ভুল: ${invalidCount}টা line-এ ৭টা অংশ নেই`,
      lines: youtubeLines.length,
      loginCookies: false,
    };
  }

  const hasLogin =
    cookieText.includes("\tSID\t") ||
    cookieText.includes("\tLOGIN_INFO\t") ||
    cookieText.includes("\t__Secure-3PSID\t");

  if (!hasLogin) {
    return {
      ok: false,
      message: "Cookie format ঠিক, কিন্তু login cookie পাওয়া যায়নি",
      lines: youtubeLines.length,
      loginCookies: false,
    };
  }

  return {
    ok: true,
    message: "Cookies OK",
    lines: youtubeLines.length,
    loginCookies: true,
  };
}

function saveCookiesFromRaw(rawText) {
  const normalized = normalizeCookieText(rawText);
  const validation = validateCookiesText(normalized);

  if (!validation.ok) {
    cookiesStatus = {
      exists: false,
      ok: false,
      message: validation.message,
      checkedAt: new Date().toISOString(),
      lines: validation.lines,
      loginCookies: validation.loginCookies,
    };

    return { ok: false, normalized, validation };
  }

  fs.writeFileSync(COOKIE_FILE, normalized, { encoding: "utf8", mode: 0o600 });

  cookiesStatus = {
    exists: true,
    ok: true,
    message: validation.message,
    checkedAt: new Date().toISOString(),
    lines: validation.lines,
    loginCookies: validation.loginCookies,
  };

  return { ok: true, normalized, validation };
}

function setupCookiesFromBase64Variable() {
  const b64 = process.env.YT_COOKIES_B64;

  if (!b64 || !b64.trim()) {
    return null;
  }

  try {
    const decoded = Buffer.from(b64.trim(), "base64").toString("utf8");
    const result = saveCookiesFromRaw(decoded);

    if (result.ok) {
      addLog("success", "YouTube cookies loaded from YT_COOKIES_B64.");
      return COOKIE_FILE;
    }

    addLog("warning", "YT_COOKIES_B64 found but cookies invalid: " + result.validation.message);
    return null;
  } catch (err) {
    addLog("error", "Failed to decode YT_COOKIES_B64: " + err.message);
    return null;
  }
}

function getCookiesArgs() {
  if (fs.existsSync(COOKIE_FILE)) {
    return ["--cookies", COOKIE_FILE];
  }

  const file = setupCookiesFromBase64Variable();

  if (file && fs.existsSync(file)) {
    return ["--cookies", file];
  }

  return [];
}

function runCommand(command, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, { shell: false });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timeout: ${stderr || stdout}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
      }
    });
  });
}

function getFormatByQuality(quality) {
  const q = String(quality || "720");

  if (q === "360") return "best[height<=360][vcodec!=none][acodec!=none]/18/best[vcodec!=none][acodec!=none]";
  if (q === "480") return "best[height<=480][vcodec!=none][acodec!=none]/18/best[vcodec!=none][acodec!=none]";
  if (q === "1080") return "best[height<=1080][vcodec!=none][acodec!=none]/22/best[vcodec!=none][acodec!=none]";

  return "best[height<=720][vcodec!=none][acodec!=none]/22/18/best[vcodec!=none][acodec!=none]";
}

async function resolveYoutubeSource(youtubeUrl, quality) {
  const format = getFormatByQuality(quality);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
    ...getCookiesArgs(),
    "-f",
    format,
    "-g",
    youtubeUrl,
  ];

  addLog("info", fs.existsSync(COOKIE_FILE) ? "Running yt-dlp with cookies..." : "Running yt-dlp without cookies...");

  const out = await runCommand("yt-dlp", args, 90000);

  const lines = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  if (!lines.length) {
    throw new Error("yt-dlp did not return a playable video source.");
  }

  return lines[0];
}

async function testCookiesWithVideo(testUrl) {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error("Cookies file not saved.");
  }

  if (!testUrl || !isValidYoutubeUrl(testUrl)) {
    return { ok: true, message: "Cookies format OK. Video link দিলে real test করা যাবে।" };
  }

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
    "--cookies",
    COOKIE_FILE,
    "-f",
    "best[height<=360][vcodec!=none][acodec!=none]/18/best",
    "-g",
    testUrl,
  ];

  await runCommand("yt-dlp", args, 90000);

  return { ok: true, message: "Cookies OK. YouTube real test passed." };
}

function parseFfmpegProgress(line) {
  const fpsMatch = line.match(/fps=\s*([0-9.]+)/i);
  if (fpsMatch) liveState.fps = Number(fpsMatch[1]) || 0;

  const brMatch = line.match(/bitrate=\s*([0-9.]+\s*kbits\/s)/i);
  if (brMatch) liveState.bitrate = brMatch[1].replace("kbits/s", "kbps");

  const dropMatch = line.match(/drop=\s*([0-9]+)/i);
  if (dropMatch) liveState.droppedFrames = Number(dropMatch[1]) || 0;
}

async function startFfmpegOnce(sourceUrl, streamKey, quality) {
  const height = String(quality || "720");

  const videoBitrate =
    height === "1080" ? "4500k" :
    height === "480" ? "1500k" :
    height === "360" ? "900k" :
    "2500k";

  const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

  const args = [
    "-hide_banner",
    "-loglevel", "info",

    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    "-re",
    "-i", sourceUrl,

    "-vf", `scale=-2:${height}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-b:v", videoBitrate,
    "-maxrate", videoBitrate,
    "-bufsize", String(parseInt(videoBitrate) * 2) + "k",

    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",

    "-f", "flv",
    rtmpUrl,
  ];

  addLog("info", "FFmpeg started.");

  ffmpegProcess = spawn("ffmpeg", args, { shell: false });

  ffmpegProcess.stderr.on("data", (d) => {
    const text = d.toString();
    parseFfmpegProgress(text);

    const clean = text.trim();
    if (clean) addLog("ffmpeg", clean);
  });

  ffmpegProcess.stdout.on("data", (d) => {
    const clean = d.toString().trim();
    if (clean) addLog("ffmpeg", clean);
  });

  ffmpegProcess.on("error", (err) => {
    liveState.lastError = err.message;
    addLog("error", err.message);
  });

  ffmpegProcess.on("close", (code) => {
    addLog("info", `FFmpeg stopped with code ${code}.`);
    ffmpegProcess = null;

    if (stopRequested) {
      liveState.running = false;
      liveState.starting = false;
      liveState.stoppedAt = new Date().toISOString();
      return;
    }

    if (liveState.loop) {
      addLog("info", "Loop is ON. Restarting video...");

      restartTimer = setTimeout(() => {
        startLiveInternal({
          youtubeUrl: liveState.youtubeUrl,
          streamKey: liveState._streamKey,
          loop: liveState.loop,
          quality: liveState.quality,
          isRestart: true,
        }).catch((err) => {
          liveState.running = false;
          liveState.starting = false;
          liveState.lastError = err.message;
          addLog("error", err.message);
        });
      }, 3000);
    } else {
      liveState.running = false;
      liveState.starting = false;
      liveState.stoppedAt = new Date().toISOString();
    }
  });
}

async function startLiveInternal({ youtubeUrl, streamKey, loop, quality, isRestart = false }) {
  if (!isRestart && (liveState.running || liveState.starting)) {
    throw new Error("A live stream is already running.");
  }

  liveState.starting = true;
  liveState.lastError = "";
  stopRequested = false;

  if (!isRestart) {
    liveState.logs = [];
    liveState.fps = 0;
    liveState.bitrate = "0 kbps";
    liveState.droppedFrames = 0;
    liveState.startedAt = new Date().toISOString();
  }

  liveState.youtubeUrl = youtubeUrl;
  liveState._streamKey = streamKey;
  liveState.loop = !!loop;
  liveState.quality = String(quality || "720");

  const sourceUrl = await resolveYoutubeSource(youtubeUrl, quality);

  addLog("success", "Video source resolved. Starting live stream...");

  liveState.running = true;
  liveState.starting = false;

  await startFfmpegOnce(sourceUrl, streamKey, quality);
}

function stopLive() {
  stopRequested = true;
  liveState.loop = false;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (ffmpegProcess) {
    addLog("info", "Stop requested. Closing FFmpeg...");
    ffmpegProcess.kill("SIGTERM");

    setTimeout(() => {
      if (ffmpegProcess) ffmpegProcess.kill("SIGKILL");
    }, 5000);
  } else {
    liveState.running = false;
    liveState.starting = false;
    liveState.stoppedAt = new Date().toISOString();
  }
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username === PANEL_USER && password === PANEL_PASS) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false, error: "Wrong username or password" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  res.json({ ok: true, loggedIn: !!(req.session && req.session.loggedIn) });
});

app.post("/api/cookies/check", isLoggedIn, async (req, res) => {
  try {
    const { cookiesText, testUrl } = req.body || {};

    if (!cookiesText || String(cookiesText).trim().length < 50) {
      return res.status(400).json({
        ok: false,
        status: {
          exists: false,
          ok: false,
          message: "Cookies box খালি বা খুব ছোট",
          checkedAt: new Date().toISOString(),
          lines: 0,
          loginCookies: false,
        },
      });
    }

    const saved = saveCookiesFromRaw(cookiesText);

    if (!saved.ok) {
      return res.status(400).json({
        ok: false,
        status: cookiesStatus,
      });
    }

    try {
      const test = await testCookiesWithVideo(testUrl);

      cookiesStatus.message = test.message;
      cookiesStatus.ok = true;
      cookiesStatus.exists = true;
      cookiesStatus.checkedAt = new Date().toISOString();

      return res.json({
        ok: true,
        status: cookiesStatus,
      });
    } catch (err) {
      cookiesStatus.ok = false;
      cookiesStatus.exists = true;
      cookiesStatus.message = "Cookies format OK, কিন্তু YouTube test failed: " + err.message.slice(0, 220);
      cookiesStatus.checkedAt = new Date().toISOString();

      return res.status(400).json({
        ok: false,
        status: cookiesStatus,
      });
    }
  } catch (err) {
    return res.status(500).json({
      ok: false,
      status: {
        exists: false,
        ok: false,
        message: err.message,
        checkedAt: new Date().toISOString(),
        lines: 0,
        loginCookies: false,
      },
    });
  }
});

app.get("/api/cookies/status", isLoggedIn, (req, res) => {
  res.json({ ok: true, status: cookiesStatus });
});

app.post("/api/start", isLoggedIn, async (req, res) => {
  try {
    const { youtubeUrl, streamKey, loop = true, quality = "720" } = req.body || {};

    if (!youtubeUrl || !isValidYoutubeUrl(youtubeUrl)) {
      return res.status(400).json({ ok: false, error: "Only YouTube video links are allowed." });
    }

    if (!streamKey || String(streamKey).trim().length < 8) {
      return res.status(400).json({ ok: false, error: "Valid YouTube stream key required." });
    }

    await startLiveInternal({
      youtubeUrl: String(youtubeUrl).trim(),
      streamKey: String(streamKey).trim(),
      loop: !!loop,
      quality: String(quality || "720"),
    });

    return res.json({ ok: true, message: "Live started" });
  } catch (err) {
    liveState.running = false;
    liveState.starting = false;
    liveState.lastError = err.message;
    addLog("error", err.message);

    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/stop", isLoggedIn, (req, res) => {
  stopLive();
  res.json({ ok: true, message: "Stopping live stream..." });
});

app.get("/api/status", isLoggedIn, (req, res) => {
  const safeState = { ...liveState };
  delete safeState._streamKey;
  res.json({ ok: true, state: safeState });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), cookies: cookiesStatus });
});

setupCookiesFromBase64Variable();

app.listen(PORT, () => {
  console.log(`YT Live Link Panel running on port ${PORT}`);
});
