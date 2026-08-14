#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PLAYWRIGHT_MODULE =
  "/Users/rickysu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";

function parseArgs(argv) {
  const args = {
    index: "/tmp/ttcdw-course-index.json",
    state: "/tmp/ttcdw-storage-state.json",
    out: "extracted/ttcdw",
    frames: 8,
    interval: 60,
    audioSeconds: 60,
    asrModel: "",
    courseId: "993290715210272768",
    lessonId: "",
    ocr: true,
    ocrBrowserFallback: false,
    headful: false,
    browserChannel: "chrome",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "no-ocr") {
      args.ocr = false;
      continue;
    }
    if (key === "ocr-browser-fallback") {
      args.ocrBrowserFallback = true;
      continue;
    }
    if (key === "headful") {
      args.headful = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (["frames", "interval"].includes(key)) args[key] = Number(value);
    else if (key === "audio-seconds") args.audioSeconds = Number(value);
    else if (key === "asr-model") args.asrModel = value;
    else if (key === "course-id") args.courseId = value;
    else if (key === "lesson-id") args.lessonId = value;
    else if (key === "storage-state") args.state = value;
    else if (key === "browser-channel") args.browserChannel = value;
    else args[key] = value;
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function redactUrl(url) {
  return String(url || "").replace(/([?&](token|access_token|Authorization|sign|signature)=)[^&]+/gi, "$1<redacted>");
}

function readCourse(indexPath, courseId, lessonId) {
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const course = index.courses.find((item) => item.id === courseId);
  if (!course) throw new Error(`Course not found: ${courseId}`);
  const lesson = lessonId
    ? course.lessons.find((item) => item.id === lessonId || item.videoId === lessonId)
    : course.lessons[0];
  if (!lesson) throw new Error(`Lesson not found in course ${courseId}: ${lessonId}`);
  return { index, course, lesson };
}

function safeName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function runTesseract(imagePath, lang) {
  const result = spawnSync("tesseract", [imagePath, "stdout", "-l", lang, "--psm", "6"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status === 0) return { ok: true, lang, text: result.stdout.trim() };
  return {
    ok: false,
    lang,
    text: "",
    error: `${result.stderr || result.stdout || "tesseract failed"}`.trim(),
  };
}

function ocrFrame(imagePath) {
  const preferred = runTesseract(imagePath, "chi_sim+eng");
  if (preferred.ok) return preferred;
  const fallback = runTesseract(imagePath, "eng");
  if (fallback.ok) {
    fallback.warning = `chi_sim+eng failed: ${preferred.error}`;
    return fallback;
  }
  return {
    ok: false,
    lang: "chi_sim+eng, eng",
    text: "",
    error: `${preferred.error}\n${fallback.error}`.trim(),
  };
}

function runFfmpeg(args) {
  return spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180000,
  });
}

function extractVideoFramesFromHls(rawM3u8Url, framesDir, frameCount, interval) {
  ensureDir(framesDir);
  const pattern = path.join(framesDir, "frame_%05d.png");
  const durationLimit = Math.max(interval * frameCount + 5, 30);
  const result = runFfmpeg([
    "-t",
    String(durationLimit),
    "-i",
    rawM3u8Url,
    "-an",
    "-vf",
    `fps=1/${interval}`,
    "-frames:v",
    String(frameCount),
    pattern,
  ]);
  const files = fs
    .readdirSync(framesDir)
    .filter((name) => /^frame_\d+\.png$/.test(name))
    .sort();
  return {
    ok: result.status === 0 && files.length > 0,
    status: result.status,
    error: redactUrl(`${result.stderr || result.stdout || ""}`.trim()).slice(0, 1000),
    captures: files.map((name, index) => ({
      second: index * interval,
      image: path.join("frames", name),
      decodedBy: "ffmpeg",
    })),
  };
}

function extractAudioFromHls(rawM3u8Url, lessonDir, audioSeconds) {
  const audioName = audioSeconds > 0 ? `audio_sample_${audioSeconds}s.wav` : "audio_full.wav";
  const audioPath = path.join(lessonDir, audioName);
  const args = [
    "-i",
    rawM3u8Url,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    audioPath,
  ];
  if (audioSeconds > 0) args.unshift("-t", String(audioSeconds));
  const result = runFfmpeg(args);
  return {
    ok: result.status === 0 && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0,
    status: result.status,
    file: fs.existsSync(audioPath) ? audioName : "",
    seconds: audioSeconds,
    error: redactUrl(`${result.stderr || result.stdout || ""}`.trim()).slice(0, 1000),
  };
}

function transcribeAudio(audio, lessonDir, modelPath) {
  if (!audio.ok || !audio.file) {
    return { ok: false, status: null, file: "", error: "No audio file available" };
  }
  if (!modelPath || !fs.existsSync(modelPath)) {
    return { ok: false, status: null, file: "", error: `ASR model not found: ${modelPath || "(empty)"}` };
  }
  const outputBase = path.join(lessonDir, audio.seconds > 0 ? "audio_transcript_sample" : "audio_transcript_full");
  const result = spawnSync(
    "whisper-cli",
    [
      "--no-gpu",
      "-m",
      modelPath,
      "-l",
      "zh",
      "-otxt",
      "-oj",
      "-of",
      outputBase,
      path.join(lessonDir, audio.file),
    ],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    },
  );
  const txtFile = `${path.basename(outputBase)}.txt`;
  return {
    ok: result.status === 0 && fs.existsSync(`${outputBase}.txt`),
    status: result.status,
    file: fs.existsSync(`${outputBase}.txt`) ? txtFile : "",
    jsonFile: fs.existsSync(`${outputBase}.json`) ? `${path.basename(outputBase)}.json` : "",
    error: `${result.stderr || result.stdout || ""}`.trim().slice(0, 1000),
  };
}

async function waitForVideo(page) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const videos = await frame.locator("video").count().catch(() => 0);
      if (videos > 0) return { frame, locator: frame.locator("video").first() };
    }
    await page.waitForTimeout(500);
  }
  throw new Error("No video element found after 90 seconds");
}

async function chooseLesson(page, lesson) {
  if (!lesson.name) return;
  const lessonText = lesson.name.replace(/\s+/g, " ").trim();
  const link = page.getByText(lessonText, { exact: false }).first();
  if (await link.count().catch(() => 0)) {
    await link.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
}

async function gotoWithRetries(page, url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 60000 });
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Navigation attempt ${attempt}/${attempts} failed: ${error.message}`);
      await page.goto("about:blank", { waitUntil: "commit", timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(2000 * attempt);
    }
  }
  throw lastError;
}

async function videoMetadata(frame) {
  return frame.evaluate(async () => {
    const video = document.querySelector("video");
    if (!video) return null;
    if (video.readyState < 1) {
      await new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener("loadedmetadata", done, { once: true });
        setTimeout(done, 10000);
      });
    }
    return {
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime || 0,
      videoWidth: video.videoWidth || 0,
      videoHeight: video.videoHeight || 0,
      paused: video.paused,
      readyState: video.readyState,
      src: video.currentSrc || video.src || "",
    };
  });
}

async function seekVideo(frame, second) {
  return frame.evaluate(async (target) => {
    const video = document.querySelector("video");
    if (!video) throw new Error("video element disappeared");
    video.muted = true;
    if (video.readyState < 1) {
      await new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener("loadedmetadata", done, { once: true });
        setTimeout(done, 10000);
      });
    }
    try {
      video.currentTime = Math.min(Math.max(target, 0), Math.max(video.duration - 1, 0));
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) };
    }
    await new Promise((resolve) => {
      const done = () => resolve();
      video.addEventListener("seeked", done, { once: true });
      setTimeout(done, 6000);
    });
    return {
      ok: true,
      currentTime: video.currentTime || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      readyState: video.readyState,
    };
  }, second);
}

function buildTimepoints(duration, frames, interval) {
  const wanted = [];
  for (let i = 0; i < frames; i += 1) wanted.push(i * interval);
  if (duration > 0) return wanted.filter((item) => item < duration - 1);
  return wanted;
}

async function main() {
  const args = parseArgs(process.argv);
  const { course, lesson } = readCourse(args.index, args.courseId, args.lessonId);
  const lessonDir = path.resolve(args.out, course.id, lesson.id);
  const browserFramesDir = path.join(lessonDir, "browser_frames");
  const decodedFramesDir = path.join(lessonDir, "frames");
  for (const generatedPath of [
    browserFramesDir,
    decodedFramesDir,
    path.join(lessonDir, "metadata.json"),
    path.join(lessonDir, "ppt_ocr.md"),
    path.join(lessonDir, "audio_sample_60s.wav"),
    path.join(lessonDir, "audio_full.wav"),
    path.join(lessonDir, "audio_transcript_sample.txt"),
    path.join(lessonDir, "audio_transcript_sample.json"),
    path.join(lessonDir, "audio_transcript_full.txt"),
    path.join(lessonDir, "audio_transcript_full.json"),
  ]) {
    fs.rmSync(generatedPath, { recursive: true, force: true });
  }
  ensureDir(browserFramesDir);

  const { chromium } = require(PLAYWRIGHT_MODULE);
  const mediaRequests = [];
  const rawMediaUrls = [];
  const launchOptions = { headless: !args.headful };
  if (args.browserChannel && args.browserChannel !== "bundled") {
    launchOptions.channel = args.browserChannel;
  }
  const browser = await chromium.launch(launchOptions);
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
  };
  if (fs.existsSync(args.state)) contextOptions.storageState = args.state;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on("request", (request) => {
    const url = request.url();
    if (/\.(m3u8|mp4|m4s|ts)(\?|$)/i.test(url) || /video|media|m3u8/i.test(url)) {
      if (/\.m3u8(\?|$)/i.test(url)) rawMediaUrls.push(url);
      mediaRequests.push({
        url: redactUrl(url),
        method: request.method(),
        resourceType: request.resourceType(),
      });
    }
  });

  try {
    await gotoWithRetries(page, course.courseUrl);
  } catch (error) {
    if (!String(page.url()).startsWith("https://www.ttcdw.cn/")) throw error;
    console.warn(`Navigation warning, continuing with current page: ${error.message}`);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch((error) => {
    console.warn(`Load-state warning, continuing with current page: ${error.message}`);
  });
  await chooseLesson(page, lesson);
  let video;
  try {
    video = await waitForVideo(page);
  } catch (error) {
    await page.screenshot({ path: path.join(lessonDir, "page_debug_no_video.png"), fullPage: false }).catch(() => undefined);
    fs.writeFileSync(
      path.join(lessonDir, "page_debug_no_video.txt"),
      [
        `url=${page.url()}`,
        `title=${await page.title().catch(() => "")}`,
        `error=${error.message}`,
      ].join("\n"),
    );
    throw error;
  }
  await video.locator.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  const meta = (await videoMetadata(video.frame)) || {};
  const timepoints = buildTimepoints(meta.duration || 0, args.frames, args.interval);

  const captures = [];
  for (const second of timepoints) {
    const seek = await seekVideo(video.frame, second);
    await page.waitForTimeout(1200);
    const filename = `frame_${String(Math.round(second)).padStart(5, "0")}s.png`;
    const filePath = path.join(browserFramesDir, filename);
    await video.locator.screenshot({ path: filePath, timeout: 10000 }).catch(async () => {
      await page.screenshot({ path: filePath, fullPage: false });
    });
    captures.push({
      second,
      timestamp: new Date().toISOString(),
      seek,
      image: path.relative(lessonDir, filePath),
    });
  }

  const rawM3u8Url = rawMediaUrls.find((url) => /\.m3u8(\?|$)/i.test(url));
  const decodedFrames = rawM3u8Url
    ? extractVideoFramesFromHls(rawM3u8Url, decodedFramesDir, args.frames, args.interval)
    : { ok: false, status: null, error: "No m3u8 URL captured", captures: [] };
  const audioSample = rawM3u8Url
    ? extractAudioFromHls(rawM3u8Url, lessonDir, args.audioSeconds)
    : { ok: false, status: null, file: "", seconds: args.audioSeconds, error: "No m3u8 URL captured" };
  const audioTranscript = args.asrModel
    ? transcribeAudio(audioSample, lessonDir, path.resolve(args.asrModel))
    : { ok: false, status: null, file: "", jsonFile: "", error: "ASR not requested; pass --asr-model <model.bin>" };
  const ocrCaptures = decodedFrames.ok ? decodedFrames.captures : args.ocrBrowserFallback ? captures : [];

  const ocrResults = [];
  if (args.ocr) {
    for (const capture of ocrCaptures) {
      const imagePath = path.join(lessonDir, capture.image);
      const result = ocrFrame(imagePath);
      ocrResults.push({ second: capture.second, image: capture.image, ...result });
    }
  }

  const metadata = {
    generatedAt: new Date().toISOString(),
    sourceType: "TTCDW authorized course playback screenshot/OCR pilot",
    course: {
      id: course.id,
      name: course.name,
      url: course.courseUrl,
      teachers: course.teachers || [],
    },
    lesson: {
      id: lesson.id,
      videoId: lesson.videoId,
      name: lesson.name,
      tag: lesson.tag,
      durationText: lesson.durationText,
    },
    videoMetadata: meta,
    browserCaptures: captures,
    decodedFrames: {
      ok: decodedFrames.ok,
      status: decodedFrames.status,
      error: decodedFrames.error,
      captures: decodedFrames.captures,
    },
    audioSample,
    audioTranscript,
    mediaRequests,
    notes: [
      "This extractor stores local study material only. Do not publish raw course frames, audio, or long OCR/transcripts to GitHub Pages.",
      "Use short, manually verified excerpts with course/lesson/timestamp citations when updating AI answer rationales.",
    ],
  };

  fs.writeFileSync(path.join(lessonDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  {
    const md = ocrResults.length
      ? [
      `# ${course.name}`,
      "",
      `## ${lesson.name}`,
      "",
      `- 课程 URL：${course.courseUrl}`,
        `- 课时 ID：${lesson.id}`,
        `- 视频 ID：${lesson.videoId || ""}`,
        `- 抽帧方式：${decodedFrames.ok ? "ffmpeg 解码 HLS 授权播放流" : "浏览器截图降级"}`,
        `- 音频文件：${audioSample.ok ? audioSample.file : `未生成（${audioSample.error || "unknown error"}）`}`,
        `- 音频转写：${audioTranscript.ok ? audioTranscript.file : `未生成（${audioTranscript.error || "unknown error"}）`}`,
        "",
        "## PPT/OCR 摘录",
      "",
      ...ocrResults.flatMap((item) => [
        `### ${Math.round(item.second)}s`,
        "",
        `- 截图：${item.image}`,
        `- OCR 语言：${item.lang}${item.warning ? `（警告：${item.warning}）` : ""}`,
        "",
        item.ok && item.text ? item.text : `OCR 失败：${item.error || "unknown error"}`,
        "",
      ]),
    ].join("\n")
      : [
          `# ${course.name}`,
          "",
          `## ${lesson.name}`,
          "",
          `- 课程 URL：${course.courseUrl}`,
          `- 课时 ID：${lesson.id}`,
          `- 视频 ID：${lesson.videoId || ""}`,
          "",
          "## PPT/OCR 摘录",
          "",
          "未生成可用 PPT OCR：未能从授权视频流解码出真实画面帧。",
          "",
          `解码状态：${decodedFrames.status === null ? "未捕获 m3u8" : decodedFrames.status}`,
          "",
          decodedFrames.error || "无更多错误信息。",
          "",
        ].join("\n");
    fs.writeFileSync(path.join(lessonDir, "ppt_ocr.md"), md);
  }

  await browser.close();

  console.log(
    JSON.stringify(
      {
        course: course.name,
        lesson: lesson.name,
        output: lessonDir,
        browserFrames: captures.length,
        decodedFrames: decodedFrames.captures.length,
        ocr: ocrResults.filter((item) => item.ok).length,
        audioSample: audioSample.ok,
        audioTranscript: audioTranscript.ok,
        mediaRequests: mediaRequests.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
