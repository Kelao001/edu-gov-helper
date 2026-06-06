(function (root) {
  const urlPattern = /https?:\/\/[^\s,\uFF0C\u3002;\uFF1B\u3001)\uFF09\u3011"'<>]+/i;
  const defaultSiteName = "\u4e2d\u534e\u6559\u80b2\u7f51";

  function cleanTitle(title) {
    return String(title || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseQQMessage(message) {
    const text = String(message || "").trim();
    const match = text.match(urlPattern);
    if (!match) {
      throw new Error("\u6ca1\u6709\u8bc6\u522b\u5230\u7a3f\u4ef6\u94fe\u63a5");
    }

    const sourceUrl = match[0];
    const beforeUrl = text.slice(0, match.index).trim();
    const title = inferTitleBeforeUrl(beforeUrl);
    const afterLines = text
      .slice(match.index + sourceUrl.length)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      title,
      sourceUrl,
      siteName: inferSiteName(afterLines)
    };
  }

  function inferTitleBeforeUrl(beforeUrl) {
    const lines = String(beforeUrl || "")
      .split(/\r?\n/)
      .map((line) => cleanTitle(line))
      .filter(Boolean);
    if (!lines.length) return "";

    const ignored = /^(标题|题目|稿件|链接|网址|发布|转发|帮发|中华教育网|首页文字链|文字链)$/i;
    const candidates = lines.filter((line) => !ignored.test(line));
    return candidates[candidates.length - 1] || lines[lines.length - 1] || "";
  }

  function inferSiteName(afterLines) {
    const joined = afterLines.join(" ");
    if (/中华教育网/.test(joined)) return defaultSiteName;
    return defaultSiteName;
  }

  function buildReplyMessage(title, publishedUrl, siteName) {
    return [cleanTitle(title), String(publishedUrl || "").trim(), siteName || defaultSiteName]
      .filter(Boolean)
      .join("\n");
  }

  root.EduGovCore = {
    buildReplyMessage,
    cleanTitle,
    inferSiteName,
    inferTitleBeforeUrl,
    parseQQMessage
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.EduGovCore;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
