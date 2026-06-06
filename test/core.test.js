const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReplyMessage, parseQQMessage } = require("../src/core");

test("parseQQMessage extracts title, source URL, and site name", () => {
  const parsed = parseQQMessage(`什么样的学生适合中外合作大学？2026三所主流院校横向对比与匹配推荐
http://news.cnmtpt.com/?Sid=16246655_6719W214089579
中华教育网`);

  assert.deepEqual(parsed, {
    title: "什么样的学生适合中外合作大学？2026三所主流院校横向对比与匹配推荐",
    sourceUrl: "http://news.cnmtpt.com/?Sid=16246655_6719W214089579",
    siteName: "中华教育网"
  });
});

test("parseQQMessage ignores changing trailing site copy", () => {
  const parsed = parseQQMessage(`常州市钱之问科技高中｜院士寄语、清北赋能、千万奖学金护航！以科学家精神探索“世纪之问”
https://v.gaoduanedu.cn/news/51202605281822039638490432
中华教育网首页文字链`);

  assert.equal(parsed.title, "常州市钱之问科技高中｜院士寄语、清北赋能、千万奖学金护航！以科学家精神探索“世纪之问”");
  assert.equal(parsed.sourceUrl, "https://v.gaoduanedu.cn/news/51202605281822039638490432");
  assert.equal(parsed.siteName, "中华教育网");
});

test("parseQQMessage accepts URL-only messages", () => {
  const parsed = parseQQMessage("https://v.gaoduanedu.cn/news/abc123 随手发来的说明文字");

  assert.equal(parsed.title, "");
  assert.equal(parsed.sourceUrl, "https://v.gaoduanedu.cn/news/abc123");
  assert.equal(parsed.siteName, "中华教育网");
});

test("parseQQMessage handles full-width punctuation after URL", () => {
  const parsed = parseQQMessage("标题\nhttps://example.com/a?b=1，中华教育网");
  assert.equal(parsed.sourceUrl, "https://example.com/a?b=1");
});

test("buildReplyMessage formats QQ response", () => {
  assert.equal(
    buildReplyMessage(" 标题 ", "http://www.edu-gov.cn/edu/27150.html", "中华教育网"),
    "标题\nhttp://www.edu-gov.cn/edu/27150.html\n中华教育网"
  );
});
