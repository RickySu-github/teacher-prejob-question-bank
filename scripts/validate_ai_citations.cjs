#!/usr/bin/env node

const fs = require("fs");

const htmlPath = process.argv[2] || "data/手机刷题冲刺.html";
const html = fs.readFileSync(htmlPath, "utf8");
const match = html.match(/const QUESTIONS = (.*?);\n  const SUBJECTS = /s);

if (!match) {
  throw new Error(`QUESTIONS block not found in ${htmlPath}`);
}

const questions = JSON.parse(match[1]);
const localSourcePattern = /教师岗前培训全题库2025\.md:L\d+/;
const urlPattern = /https?:\/\/[^\s；。)）]+/;

const localSourceHits = [];
const badClaims = [];
const badSourceObjects = [];
const unverifiedTtcdwSources = [];
const nonExtractedSources = [];
let externallyCited = 0;

function isExtractedSource(source) {
  const article = String(source && source.article || "");
  const sourceType = String(source && (source.sourceType || source.kind) || "");
  return /PPT\/OCR|PPT OCR|音频转写|audio_transcript|ppt_ocr/i.test(article)
    || /ppt_ocr|audio_transcript/i.test(sourceType);
}

for (const q of questions) {
  const aiExplain = String(q.ai_explain || "");
  const explain = String(q.explain || "");

  if (localSourcePattern.test(aiExplain) || localSourcePattern.test(explain) || localSourcePattern.test(String(q.ai_source || ""))) {
    localSourceHits.push(q.id);
  }

  const rationaleLine = aiExplain.split("\n").find((line) => line.startsWith("分析答案由来：")) || "";
  const claimsExternalSource = ["教材原文佐证", "网上教材/备考资料佐证", "资料佐证", "资料来源"].some((mark) => rationaleLine.includes(mark));
  if (claimsExternalSource && !urlPattern.test(rationaleLine)) {
    badClaims.push(q.id);
  }

  if (Array.isArray(q.ai_sources)) {
    const validSources = q.ai_sources.filter((source) => source && /^https?:\/\//.test(source.url || "") && source.title && source.quote);
    if (validSources.length !== q.ai_sources.length) badSourceObjects.push(q.id);
    if (validSources.length) externallyCited += 1;
    if (q.ai_sources.some((source) => !isExtractedSource(source))) nonExtractedSources.push(q.id);

    const hasUnverifiedTtcdw = q.ai_sources.some((source) => {
      if (!source || !/^https:\/\/www\.ttcdw\.cn\/p\/course\/v\/v_/.test(source.url || "")) return false;
      const article = String(source.article || "");
      const sourceType = String(source.sourceType || source.kind || "");
      return !(/PPT\/OCR|PPT OCR|音频转写|audio_transcript|ppt_ocr/i.test(article) || /ppt_ocr|audio_transcript/i.test(sourceType));
    });
    if (hasUnverifiedTtcdw || /TTCDW课程资源佐证（.*课程简介\/课程目录/.test(aiExplain)) {
      unverifiedTtcdwSources.push(q.id);
    }
  }
}

console.log({
  total: questions.length,
  externallyCited,
  localSourceHits: localSourceHits.length,
  badClaims: badClaims.length,
  badSourceObjects: badSourceObjects.length,
  unverifiedTtcdwSources: unverifiedTtcdwSources.length,
  nonExtractedSources: nonExtractedSources.length
});

if (localSourceHits.length || badClaims.length || badSourceObjects.length || unverifiedTtcdwSources.length || nonExtractedSources.length) {
  console.log({
    localSourceHits: localSourceHits.slice(0, 10),
    badClaims: badClaims.slice(0, 10),
    badSourceObjects: badSourceObjects.slice(0, 10),
    unverifiedTtcdwSources: unverifiedTtcdwSources.slice(0, 10),
    nonExtractedSources: nonExtractedSources.slice(0, 10)
  });
  throw new Error("AI citation validation failed");
}
