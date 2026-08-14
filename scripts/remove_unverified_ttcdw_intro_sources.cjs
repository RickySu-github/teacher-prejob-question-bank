#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const htmlPath = process.argv[2] || "手机刷题冲刺.html";
const html = fs.readFileSync(htmlPath, "utf8");
const match = html.match(/const QUESTIONS = (.*?);\n  const SUBJECTS = /s);

if (!match) {
  throw new Error(`QUESTIONS block not found in ${htmlPath}`);
}

const questions = JSON.parse(match[1]);

function isVerifiedExtractedSource(source) {
  if (!source || !source.url) return false;
  const article = String(source.article || "");
  const sourceType = String(source.sourceType || source.kind || "");
  return /PPT\/OCR|PPT OCR|音频转写|audio_transcript|ppt_ocr/i.test(article)
    || /ppt_ocr|audio_transcript/i.test(sourceType);
}

function correctAnswerText(question) {
  if (question.type === "tf") return question.answer;
  const correct = (question.options || []).filter((option) => option.is_correct);
  if (correct.length) return correct.map((option) => `${option.key}.${option.text}`).join("；");
  return question.answer;
}

function stripUnverifiedTtcdwFromAnalysis(text) {
  return String(text || "")
    .replace(/TTCDW课程资源佐证（.*?，课程简介\/课程目录）：原文写明“.*?”。资料来源：https:\/\/www\.ttcdw\.cn\/p\/course\/v\/v_\d+\?[^ ]+ ?/g, "")
    .replace(/TTCDW课程资源佐证（.*?）：原文写明“.*?”。资料来源：https:\/\/www\.ttcdw\.cn\/p\/course\/v\/v_\d+\?[^ ]+ ?/g, "")
    .replace(/分析答案由来：\s+/, "分析答案由来：")
    .trim();
}

function pendingExplain(question, remainingExplain) {
  const lines = String(remainingExplain || "").split("\n");
  const kept = lines.filter((line) => !line.startsWith("分析答案由来："));
  return [
    `正确答案：${correctAnswerText(question)}`,
    "分析答案由来：待绑定 PPT/OCR 或音频转写文本。当前尚未取得可核验的课程视频文本摘录，因此不能把课程简介、目录或相近主题材料写成教材依据。",
    ...kept.filter((line) => !line.startsWith("正确答案：")),
  ].join("\n");
}

let removedSources = 0;
let rewrittenExplains = 0;

for (const question of questions) {
  const beforeSources = Array.isArray(question.ai_sources) ? question.ai_sources : [];
  const nextSources = beforeSources.filter((source) => isVerifiedExtractedSource(source));
  removedSources += beforeSources.length - nextSources.length;
  question.ai_sources = nextSources;

  const beforeExplain = String(question.ai_explain || "");
  const stripped = stripUnverifiedTtcdwFromAnalysis(beforeExplain).replace(
    "分析答案由来：待绑定 PPT/OCR 或音频转写原文。当前尚未取得可核验的课程视频文本摘录，因此不能把课程简介、目录或相近主题材料写成教材原文佐证。",
    "分析答案由来：待绑定 PPT/OCR 或音频转写文本。当前尚未取得可核验的课程视频文本摘录，因此不能把课程简介、目录或相近主题材料写成教材依据。",
  );
  const hasUnverifiedIntro = beforeExplain !== stripped || /课程简介\/课程目录/.test(beforeExplain);
  const removedAnySource = beforeSources.length !== nextSources.length;
  const hasReliableRemainingSource = nextSources.some((source) => source && source.url && source.quote);

  if ((hasUnverifiedIntro || removedAnySource || /资料来源：|原文佐证|资料佐证/.test(stripped)) && !hasReliableRemainingSource) {
    question.ai_explain = pendingExplain(question, stripped);
  } else if (hasUnverifiedIntro || removedAnySource) {
    question.ai_explain = stripped;
  }

  if (question.ai_explain !== beforeExplain) rewrittenExplains += 1;
}

const nextHtml = html.replace(
  /const QUESTIONS = (.*?);\n  const SUBJECTS = /s,
  `const QUESTIONS = ${JSON.stringify(questions)};\n  const SUBJECTS = `,
);

fs.writeFileSync(htmlPath, nextHtml);
console.log(
  JSON.stringify(
    {
      html: path.resolve(htmlPath),
      total: questions.length,
      removedSources,
      rewrittenExplains,
    },
    null,
    2,
  ),
);
