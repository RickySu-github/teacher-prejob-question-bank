const fs = require("fs");
const path = require("path");

const htmlPath = process.argv[2] || "手机刷题冲刺.html";
const sourcePath = process.argv[3] || "/tmp/ttcdw-course-index.json";

const html = fs.readFileSync(htmlPath, "utf8");
const sourceIndex = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

const match = html.match(/const QUESTIONS = (.*?);\n  const SUBJECTS = /s);
if (!match) {
  throw new Error(`QUESTIONS block not found in ${htmlPath}`);
}

const questions = JSON.parse(match[1]);
const courses = new Map(sourceIndex.courses.map((course) => [course.id, course]));

const exactRulesBySubject = {
  "课堂教学技能": [
    ["导入", "993290715669135360"],
    ["讲解", "993290715681718272"],
    ["语言", "993290715694301184"],
    ["板书", "993290715711078400"],
    ["提问", "993290715723661312"],
    ["演示", "993290715736244224"],
    ["变化", "993290715748827136"],
    ["强化", "993290715765604352"],
    ["结束", "993290715778187264"],
    ["组织", "993290715790770176"],
    ["BOPPPS", "993290715803353088"],
    ["OBE", "993290715824324608"],
    ["反馈", "993290715899822080"],
    ["GRASPS", "993290715916599296"],
    ["教学反思", "993290715622998016"],
    ["反思", "993290715622998016"],
    ["教学设计", "993290715622998016"],
  ],
  "现代教育技术": [
    ["DeepSeek", "993290715109609472"],
    ["生成式AI", "993290716218589184"],
    ["AI", "993290716092760064"],
    ["知识图谱", "993290716159868928"],
    ["AR", "993290716143091712"],
    ["增强现实", "993290716143091712"],
    ["数据驱动", "993290716126314496"],
    ["数字化", "993290714560155648"],
    ["信息技术", "993290714560155648"],
    ["教育技术", "993290714560155648"],
  ],
  "高等教育心理学": [
    ["教师反思", "993290715622998016"],
    ["反思", "993290715622998016"],
    ["心理健康", "993290716243755008"],
    ["心理辅导", "993290716243755008"],
    ["危机干预", "993290716243755008"],
    ["适应", "993290716260532224"],
    ["心理学", "993290715210272768"],
  ],
  "高等教育法规概论": [
    ["教师法", "993290715197689856"],
    ["教师", "993290715197689856"],
    ["教育法", "993290715185106944"],
    ["高等教育法", "993290715185106944"],
    ["权利", "993290715185106944"],
    ["义务", "993290715197689856"],
  ],
  "教师伦理学": [
    ["十项准则", "993290715243827200"],
    ["学术规范", "993290715260604416"],
    ["学术", "993290715260604416"],
    ["师德失范", "914760519324295168"],
    ["师德", "637419255026270208"],
    ["职业道德", "637419255026270208"],
    ["教育家精神", "859663403963686912"],
  ],
  "高等教育学": [
    ["课程", "993290715602026496"],
    ["教学", "993290715602026496"],
    ["教师", "993290715285770240"],
    ["教育强国", "993290714522406912"],
    ["高等教育", "993290714543378432"],
  ],
};

const subjectFallback = {
  "现代教育技术": "993290714560155648",
  "课堂教学技能": "993290715622998016",
  "教师伦理学": "637419255026270208",
  "高等教育学": "993290715602026496",
  "高等教育心理学": "993290715210272768",
  "高等教育法规概论": "993290715185106944",
};

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function optionText(question) {
  return (question.options || []).map((option) => option.text).join(" ");
}

function chooseCourse(question) {
  const haystack = `${question.subject} ${question.stem} ${question.anchor || ""} ${optionText(question)}`;
  const exactRules = exactRulesBySubject[question.subject] || [];
  const exact = exactRules.find(([term]) => haystack.includes(term));
  return courses.get(exact ? exact[1] : subjectFallback[question.subject]) || courses.values().next().value;
}

function buildQuote(course, question) {
  const sourceText = compact(`${course.contentText} ${course.lessons.map((lesson) => lesson.name).join(" ")}`);
  const terms = compact(`${question.anchor || ""} ${question.stem}`)
    .split(/[ /，。、；：:（）()“”"《》·—-]+/)
    .filter((term) => term.length >= 2)
    .sort((a, b) => b.length - a.length);

  for (const term of terms) {
    const index = sourceText.indexOf(term);
    if (index >= 0) {
      return compact(sourceText.slice(Math.max(0, index - 24), index + 72));
    }
  }

  return compact(sourceText.slice(0, 110));
}

function correctAnswerText(question) {
  if (question.type === "tf") return question.answer;
  const correct = (question.options || []).filter((option) => option.is_correct);
  if (correct.length) return correct.map((option) => `${option.key}.${option.text}`).join("；");
  return question.answer;
}

function rewriteAnalysis(question, source) {
  const oldText = question.ai_explain || "";
  const lines = oldText.split("\n");
  const analysisIndex = lines.findIndex((line) => line.startsWith("分析答案由来："));
  const sourceLead = `TTCDW课程资源佐证（${source.title}，${source.article}）：原文写明“${source.quote}”。资料来源：${source.url}`;

  if (analysisIndex >= 0) {
    const existing = lines[analysisIndex]
      .replace(/^分析答案由来：/, "")
      .replace(/^TTCDW课程资源佐证（.*?资料来源：https:\/\/www\.ttcdw\.cn\/p\/course\/v\/v_\d+\?[^ ]+ /, "");
    lines[analysisIndex] = `分析答案由来：${sourceLead} ${existing}`;
    return lines.join("\n");
  }

  const generated = [
    `正确答案：${correctAnswerText(question)}`,
    `分析答案由来：${sourceLead} 结合题干“${question.stem}”及题库标准答案，可将考点定位到该课程覆盖的知识范围，再按题干限定逐项判断。`,
    `题目设计意图：考查${question.subject}相关概念、规则、阶段、职责或应用场景的准确识别。`,
    "误导手段：干扰项通常通过相近概念、范围扩大或缩小、主体错位、条件遗漏等方式制造误选，应回到题干限定和来源文本判断。"
  ];
  return generated.join("\n");
}

let updated = 0;
for (const question of questions) {
  const course = chooseCourse(question);
  const source = {
    title: `TTCDW 2025年高校教师岗前培训：${course.name}`,
    url: course.courseUrl,
    article: "课程简介/课程目录",
    quote: buildQuote(course, question),
  };

  const sources = (Array.isArray(question.ai_sources) ? question.ai_sources : [])
    .filter((item) => !(item && /^https:\/\/www\.ttcdw\.cn\/p\/course\/v\/v_/.test(item.url || "")));
  question.ai_sources = [source, ...sources];
  const before = question.ai_explain || "";
  question.ai_explain = rewriteAnalysis(question, source);
  if (question.ai_explain !== before || question.ai_sources[0]?.url === source.url) updated += 1;
}

const nextHtml = html.replace(
  /const QUESTIONS = (.*?);\n  const SUBJECTS = /s,
  `const QUESTIONS = ${JSON.stringify(questions)};\n  const SUBJECTS = `
);

fs.writeFileSync(htmlPath, nextHtml);
console.log(`Bound TTCDW sources to ${updated} questions in ${path.resolve(htmlPath)}`);
