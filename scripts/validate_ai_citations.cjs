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
let externallyCited = 0;

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
  }
}

console.log({
  total: questions.length,
  externallyCited,
  localSourceHits: localSourceHits.length,
  badClaims: badClaims.length,
  badSourceObjects: badSourceObjects.length
});

if (localSourceHits.length || badClaims.length || badSourceObjects.length) {
  console.log({
    localSourceHits: localSourceHits.slice(0, 10),
    badClaims: badClaims.slice(0, 10),
    badSourceObjects: badSourceObjects.slice(0, 10)
  });
  throw new Error("AI citation validation failed");
}
